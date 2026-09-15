import express from 'express';
import { resolve } from 'node:path';
import { z } from 'zod';
import { createApp } from './app.mjs';
import { createModelStore, routesSchema } from './models.mjs';
import { createIntegrationPreferences } from './integrations.mjs';
import { briefSchema } from './domain.mjs';

const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const rows = (max = 1000) => z.array(z.record(z.string(), z.unknown())).max(max);
const stateSchema = z.object({
  schemaVersion: z.literal(1), accounts: rows(20), activities: rows(100),
  contentRules: rows(500).optional(), rulesRevision: z.number().int().nonnegative().optional(),
  projects: z.array(z.object({ id: identifier, brief: briefSchema, revision: z.number().int().nonnegative(),
    strategies: rows(100), assets: rows(100), publications: rows(200), comments: rows(10000),
    insights: rows(500), experiences: rows(500), usage: rows(2000), corpus: rows(50).optional(),
  }).passthrough()).max(1),
}).strict();
const envelopeSchema = z.object({
  path: z.string().max(350), method: z.enum(['GET', 'POST', 'PUT', 'DELETE']), body: z.unknown().optional(),
  state: stateSchema,
  credentials: z.object({ openai: z.string().max(512).optional(), deepseek: z.string().max(512).optional(), seedance: z.string().max(512).optional(), douyin: z.string().max(100000).optional() }).strict(),
  routes: routesSchema,
  seedance: z.unknown().optional(),
  authorizations: z.array(z.tuple([z.string().max(100), z.object({ accountId: identifier, expiresAt: z.number().finite(), redirectUri: z.string().url().max(2048) }).strict()])).max(10).default([]),
}).strict();

// This is an operation endpoint, never an arbitrary URL proxy or a persistent workspace.
export function allowedWebOperation(path, method) {
  if (path === '/tick') return method === 'POST';
  if (path === '/settings/credential/check') return method === 'POST';
  if (path === '/settings/providers/deepseek/credential/check') return method === 'POST';
  if (/^\/integrations\/douyin\/(authorize|complete)$/.test(path)) return method === 'POST';
  if (!path.startsWith('/projects/')) return false;
  const id = '[a-zA-Z0-9_-]{1,100}';
  if (new RegExp(`^/projects/${id}/(strategies|analysis|comments/classify)$`).test(path)) return method === 'POST';
  if (new RegExp(`^/projects/${id}/assets/${id}/(copy|keyframes|seedance|video-status|generation-reset)$`).test(path)) return method === 'POST';
  if (new RegExp(`^/projects/${id}/publications/${id}/(automatic|stop-automatic|platform-status|platform-item|comments-sync)$`).test(path)) return method === 'POST' || (path.endsWith('/comments-sync') && method === 'PUT');
  return false;
}

function memoryVault(credentials, name) {
  return {
    status: () => ({ configured: !!credentials[name], supported: true, suffix: credentials[name]?.slice(-4) || '', protection: '浏览器密码加密 · 请求内存临时解密', problem: '' }),
    getKey: async () => credentials[name] || '',
    save: async value => { credentials[name] = value; },
    remove: () => { delete credentials[name]; },
  };
}

export function createWebRelay({ staticDirectory = resolve('web-dist'), publicOrigin, allowLocalHttp = false, workspaceOptions = {}, maxActive = 1 } = {}) {
  const origin = new URL(publicOrigin);
  if (origin.href !== origin.origin + '/' || origin.username || origin.password || (origin.protocol !== 'https:' && !(allowLocalHttp && origin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(origin.hostname)))) throw new Error('WEB_PUBLIC_ORIGIN 必须是网站的 HTTPS 根地址');
  const app = express(); app.disable('x-powered-by');
  let active = 0, closing = false;
  const running = new Set(), rates = new Map();
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self' data: blob:; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'" });
    if (origin.protocol === 'https:') res.set('Strict-Transport-Security', 'max-age=31536000');
    if (req.path === '/api/health' && req.method === 'GET') return res.status(closing ? 503 : 200).json({ ok: !closing, mode: 'web-local', storage: 'browser-encrypted', serverStoresWorkspaces: false, version: '0.5.0' });
    if (req.get('Host') !== origin.host || (req.get('Origin') && req.get('Origin') !== origin.origin)) return res.status(403).json({ error: '请从网站的正式地址访问' });
    if (closing) return res.status(503).json({ error: '联网服务正在更新，请稍后重试' });
    next();
  });
  app.post('/api/web/execute', (req, res, next) => {
    if (req.get('X-Studio-Client') !== 'studio-v1' || !req.is('application/json')) return res.status(403).json({ error: '请从工作区发起请求' });
    // No access/body/credential logs. The rate key exists in memory for only one minute.
    const key = req.socket.remoteAddress, now = Date.now();
    for (const [id, value] of rates) if (value.until <= now) rates.delete(id);
    const rate = rates.get(key) || { count: 0, until: now + 60000 }; rates.set(key, rate);
    if (++rate.count > 120 || active >= maxActive) return res.status(429).json({ error: '联网服务繁忙，请稍后重试；尚未调用服务商' });
    active++; let released = false;
    res.locals.release = () => { if (!released) { released = true; active--; } };
    next();
  }, express.json({ limit: '32mb' }), async (req, res) => {
    let workspace, input, state;
    const json = res.json.bind(res);
    let finished = false;
    let settle;
    const completion = new Promise(accept => { settle = accept; }); running.add(completion);
    const finish = async (payload, status = 200) => {
      if (finished) return; finished = true;
      try {
        await workspace?.locals.integrations.close();
        // Return modified credentials only when the platform has refreshed/exchanged tokens.
        const response = { ...payload }, hasState = Object.hasOwn(response, 'state'); delete response.state;
        json.call(res.status(200), { status, response, hasState, state, apiDiagnostic: workspace?.locals.openaiTransport.diagnostic() || null, deepseekDiagnostic: workspace?.locals.deepseekTransport.diagnostic() || null, credentials: input.credentials.douyin ? { douyin: input.credentials.douyin } : {}, authorizations: [...authorizations] });
      } catch { if (!res.headersSent) json.call(res.status(500), { error: '本次请求未能完成，请核对服务商记录后再试' }); }
      finally {
        req.body = undefined; state = undefined;
        for (const name of Object.keys(input?.credentials || {})) input.credentials[name] = '';
        authorizations.clear(); input = undefined; workspace = undefined;
        res.locals.release(); running.delete(completion); settle();
      }
    };
    const authorizations = new Map();
    try {
      input = envelopeSchema.parse(req.body);
      if (!allowedWebOperation(input.path, input.method)) throw failure('此操作不由联网服务处理', 404);
      if (input.path.startsWith('/projects/') && input.state.projects[0]?.id !== input.path.split('/')[2]) throw failure('请求项目不匹配');
      state = structuredClone(input.state);
      const store = { get: () => structuredClone(state), mutate(callback) { const next = structuredClone(state); const result = callback(next); state = next; return result; } };
      const modelStore = createModelStore(); modelStore.save(input.routes);
      const preferences = createIntegrationPreferences();
      if (input.seedance?.model) preferences.save(input.seedance);
      for (const [key, value] of input.authorizations) if (value.expiresAt > Date.now()) authorizations.set(key, value);
      workspace = createApp(store, { ...workspaceOptions, apiKey: '', password: '', allowedOrigins: [origin.origin],
        authorizeCredentials: request => request === req, modelStore, integrationPreferences: preferences, authorizations,
        vault: memoryVault(input.credentials, 'openai'), deepseekVault: memoryVault(input.credentials, 'deepseek'), seedanceVault: memoryVault(input.credentials, 'seedance'), douyinVault: memoryVault(input.credentials, 'douyin'),
      });
      if (input.path === '/tick') { await workspace.locals.integrations.tick(); await finish({ result: { checked: true } }); return; }
      req.url = `/api${input.path}`; req.method = input.method; req.body = input.body || {};
      res.json = payload => { const status = res.statusCode; res.json = json; void finish(payload, status); return res; };
      workspace(req, res, error => { void finish({ error: error ? '操作失败，请核对输入与服务商记录' : '操作不存在' }, error ? 500 : 404); });
    } catch (error) {
      finished = true; res.json = json;
      res.status(error instanceof z.ZodError ? 400 : error.status || 500).json({ error: error instanceof z.ZodError ? '请求格式或数据大小不符合要求，未调用服务商' : error.status ? error.message : '联网服务暂时无法处理请求' });
      await workspace?.locals.integrations.close(); res.locals.release(); running.delete(completion); settle();
    }
  });
  app.get('/oauth/douyin/callback', (_req, res) => res.type('html').send('<!doctype html><meta charset="utf-8"><title>返回生长工作台</title><h1>返回工作台完成授权</h1><p>复制地址栏的完整地址，回到原来打开的工作台，在抖音连接中粘贴。不要关闭原来的工作区。</p>'));
  app.use('/api', (_req, res) => res.status(404).json({ error: '此网站不保存账号或工作区；请使用浏览器本地工作区' }));
  app.use(express.static(staticDirectory, { index: false }));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve(staticDirectory, 'index.html')));
  app.use((error, _req, res, _next) => { res.locals.release?.(); res.status(error.type === 'entity.too.large' ? 413 : 400).json({ error: '请求无法读取或超过 32 MB，未执行操作' }); });
  app.locals.close = async () => { closing = true; await Promise.allSettled([...running]); rates.clear(); };
  return app;
}
