import { z } from 'zod';
import { localAPI } from './local-api';
import { changeLocalState, localUsername, readLocalState } from './local-vault';
import { mergeRelayState } from '../server/web-merge.mjs';
import { webPayload } from './web-payload';
import catalog from './static-settings.json';
import type { Integrations, Settings, State, WebPrivate } from './types';

const defaults = (): WebPrivate => ({ credentials: {}, routes: { ...catalog.routes }, seedance: { region: 'volcengine', model: '', reservationUsd: 2, outputPriceUsd: 0 }, authorizations: [], verification: null });
const privateOf = (state: State) => state.webPrivate || defaults();
export const publicState = (state: State): State => { const copy = structuredClone(state); delete copy.webPrivate; return copy; };
let onlineBusy = false;
const pendingMessage = '有一项联网请求尚未确认。请核对服务商结果，再到设置页解除锁定；不会自动重复提交。';
function settingsOf(state: State): Settings {
  const saved = privateOf(state), model = saved.routes.strategy;
  return { ...catalog, routes: saved.routes, model, ...catalog.models[model as keyof typeof catalog.models], authEnabled: true, version: '0.5.0 · 联网网页版', browserStorage: true,
    openaiConfigured: !!saved.credentials.openai, verification: saved.verification, apiDiagnostic: saved.apiDiagnostic,
    pendingWebRequest: saved.pending, recoveredWebResults: saved.recovery?.length || 0,
    credential: { supported: true, editable: true, local: true, configured: !!saved.credentials.openai, suffix: saved.credentials.openai?.slice(-4) || '', source: saved.credentials.openai ? 'vault' : 'none', protection: '浏览器 · 登录密码 AES-GCM 加密', problem: '' },
  } as Settings;
}
function integrationsOf(state: State): Integrations {
  const saved = privateOf(state), douyin = JSON.parse(saved.credentials.douyin || '{"accounts":{}}');
  return { local: true, seedance: { ...saved.seedance, supported: true, configured: !!saved.credentials.seedance, suffix: saved.credentials.seedance?.slice(-4) || '', problem: '' },
    douyin: { supported: true, configured: !!douyin.clientKey, clientKeySuffix: douyin.clientKey?.slice(-4) || '', redirectUri: douyin.redirectUri || '', accounts: Object.entries(douyin.accounts || {}).map(([id, raw]) => { const value = raw as Integrations['douyin']['accounts'][number]; return { id, scopes: value.scopes, expiresAt: value.expiresAt, refreshExpiresAt: value.refreshExpiresAt, connectionId: value.connectionId }; }) },
  };
}
async function exclusive<T>(work: () => Promise<T>): Promise<T> {
  if (onlineBusy) throw new Error('当前工作区正在处理联网请求，请稍候');
  if (!navigator.locks) throw new Error('请使用支持安全任务锁的新版 Chrome、Edge 或 Safari 浏览器');
  return navigator.locks.request(`shengzhang-web:${localUsername()}`, { ifAvailable: true }, async lock => {
    if (!lock) throw new Error('另一个标签页正在处理此用户的联网请求');
    onlineBusy = true;
    try { return await work(); } finally { onlineBusy = false; }
  });
}
async function saveConnection(work: (saved: WebPrivate, state: State) => void) {
  return exclusive(async () => changeLocalState(state => { state.webPrivate ||= defaults(); if (state.webPrivate.pending) throw new Error(pendingMessage); work(state.webPrivate, state); }));
}
async function relay(path: string, method: string, body: unknown, projectId?: string) {
  return exclusive(async () => {
    const started = await changeLocalState(state => {
      state.webPrivate ||= defaults();
      if (state.webPrivate.pending) throw new Error(pendingMessage);
      const limited = state.webPrivate.apiDiagnostic;
      const openaiModel = path.endsWith('/keyframes') ? 'gpt-image-2' : path.endsWith('/copy') ? state.webPrivate.routes.copy : path.endsWith('/classify') ? state.webPrivate.routes.classification : path.endsWith('/analysis') ? state.webPrivate.routes.analysis : path.endsWith('/strategies') ? state.webPrivate.routes[(body as { stage?: 'strategy' | 'planning' })?.stage || 'strategy'] : '';
      if (limited?.kind === 'rate_limit' && limited.model === openaiModel && limited.retryAt && Date.parse(limited.retryAt) > Date.now()) throw new Error(`OpenAI 仍在限流等待期，请 ${Math.ceil((Date.parse(limited.retryAt) - Date.now()) / 1000)} 秒后再试。本次未发送新请求。`);
      const pending = { id: crypto.randomUUID(), path, projectId, at: new Date().toISOString() };
      state.webPrivate.pending = pending; return pending;
    });
    const identity = localUsername(), pending = started.result, saved = privateOf(started.state);
    const base = webPayload(started.state, path, body, projectId);
    const credentials: WebPrivate['credentials'] = {};
    const openai = path.includes('/settings/credential') || /\/(strategies|analysis|classify|copy|keyframes)$/.test(path);
    const seedance = /\/(seedance|video-status|generation-reset|tick)$/.test(path);
    const douyin = path.includes('/douyin/') || path.includes('/publications/') || path === '/tick';
    if (openai && saved.credentials.openai) credentials.openai = saved.credentials.openai;
    if (seedance && saved.credentials.seedance) credentials.seedance = saved.credentials.seedance;
    if (douyin && saved.credentials.douyin) credentials.douyin = saved.credentials.douyin;
    const envelope = { path, method, body, state: base, credentials, routes: saved.routes, seedance: saved.seedance, authorizations: douyin ? saved.authorizations : [] };
    let response;
    try {
      const encoded = JSON.stringify(envelope);
      if (new TextEncoder().encode(encoded).byteLength > 32 * 1024 * 1024) throw new Error('此项目的素材超过单次联网请求 32 MB 上限，请减少旧成品素材后再试');
      const request = await fetch('/api/web/execute', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio-Client': 'studio-v1' }, body: encoded, credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(350000) });
      response = await request.json();
      if (!request.ok) {
        // These responses are issued before dispatch; retrying later cannot duplicate a task.
        if ([400, 403, 404, 413, 429, 503].includes(request.status)) {
          await changeLocalState(state => { if (state.webPrivate?.pending?.id === pending.id) delete state.webPrivate.pending; });
        }
        throw new Error(response.error || '联网服务暂时无法处理请求');
      }
      if (!response.state || !Number.isInteger(response.status)) throw new Error('联网结果不完整');
    } catch (error) {
      if (error instanceof Error && /32 MB/.test(error.message)) await changeLocalState(state => { if (state.webPrivate?.pending?.id === pending.id) delete state.webPrivate.pending; });
      throw new Error(`${error instanceof Error ? error.message : '网络连接中断'}。如请求已发出，请核对服务商结果，勿重复提交。`);
    }
    if (identity !== localUsername()) throw new Error('工作区已退出，联网结果未写入其他用户；重新登录后请核对服务商结果');
    let conflict = false;
    const committed = await changeLocalState(state => {
      const current = state.webPrivate!;
      if (current?.pending?.id !== pending.id) throw new Error('请求状态已改变，请核对服务商结果');
      try { Object.assign(state, mergeRelayState(base, response.state, state)); }
      catch {
        conflict = true; current.recovery = [...(current.recovery || []), { at: new Date().toISOString(), projects: response.state.projects }];
        // Preserve charged usage even when copy conflicts with a newer local edit.
        for (const p of response.state.projects as State['projects']) { const local = state.projects.find(v => v.id === p.id); if (local) for (const usage of p.usage) if (!local.usage.some(u => u.id === usage.id)) local.usage.push(usage); }
      }
      state.webPrivate = current;
      if (douyin && response.credentials?.douyin) current.credentials.douyin = response.credentials.douyin;
      if (douyin) current.authorizations = response.authorizations || [];
      if (path === '/settings/credential/check') current.verification = response.response.verification || null;
      if (openai) current.apiDiagnostic = response.apiDiagnostic || (path === '/settings/credential/check' && current.apiDiagnostic?.endpoint !== 'models' ? current.apiDiagnostic : null);
      delete current.pending;
    });
    if (conflict) throw new Error('联网结果与同时进行的本地编辑有冲突。两份内容已保留；可在设置页导出保留的结果。');
    if (response.status >= 400) throw new Error(response.response.error || '服务商未完成请求，请检查设置');
    return response.hasState ? { ...response.response, state: publicState(committed.state) } : response.response;
  });
}

export async function webAPI<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  if (path === '/health') return { ok: true, authRequired: false, mode: 'web-local' } as T;
  if (path === '/settings' && method === 'GET') return settingsOf(await readLocalState()) as T;
  if (path === '/integrations' && method === 'GET') return integrationsOf(await readLocalState()) as T;
  if (path === '/web/recovery' && method === 'GET') return (privateOf(await readLocalState()).recovery || []) as T;
  if (path === '/web/acknowledge' && method === 'POST') {
    return exclusive(async () => {
      if ((body as { confirmed?: boolean })?.confirmed !== true) throw new Error('请先核对服务商中的任务和账单');
      await changeLocalState(state => {
        const saved = state.webPrivate, pid = saved?.pending?.projectId;
        const p = state.projects.find(v => v.id === pid);
        if (p) {
          for (const pub of p.publications) if (pub.automation && ['queued', 'uploading', 'submitting'].includes(pub.automation.status)) Object.assign(pub.automation, { status: 'uncertain', error: '浏览器请求中断，请核对平台结果后重新安排' });
          for (const asset of p.assets) if (asset.aiProduction && ['generating-frame', 'submitting-video'].includes(asset.aiProduction.phase)) Object.assign(asset.aiProduction, { phase: 'uncertain', error: '请求中断，请核对服务商控制台' });
        }
        if (saved) delete saved.pending;
      }); return { ok: true } as T;
    });
  }
  if (path === '/settings/credential' && ['PUT', 'DELETE'].includes(method)) {
    await saveConnection(saved => { if (method === 'DELETE') delete saved.credentials.openai; else saved.credentials.openai = z.object({ apiKey: z.string().trim().regex(/^sk-[A-Za-z0-9_-]{16,509}$/) }).strict().parse(body).apiKey; saved.verification = null; saved.apiDiagnostic = null; });
    return settingsOf(await readLocalState()) as T;
  }
  if (path === '/settings/models' && method === 'PUT') {
    const schema = z.object(Object.fromEntries(catalog.stages.map(s => [s.id, z.enum(Object.keys(catalog.models) as [string, ...string[]])]))).strict();
    await saveConnection(saved => { saved.routes = schema.parse(body) as WebPrivate['routes']; saved.verification = null; }); return settingsOf(await readLocalState()) as T;
  }
  if (path === '/integrations/seedance' && ['PUT', 'DELETE'].includes(method)) {
    await saveConnection(saved => {
      if (method === 'DELETE') { delete saved.credentials.seedance; return; }
      const { apiKey, ...config } = z.object({ region: z.enum(['volcengine', 'byteplus']), model: z.string().trim().min(3).max(120).regex(/^[A-Za-z0-9_-]+$/), reservationUsd: z.number().min(.1).max(100), outputPriceUsd: z.number().min(0).max(1000), apiKey: z.string().trim().min(8).max(512).regex(/^[A-Za-z0-9_.-]+$/).optional() }).strict().parse(body);
      saved.seedance = config; if (apiKey) saved.credentials.seedance = apiKey;
    }); return integrationsOf(await readLocalState()) as T;
  }
  if (path === '/integrations/douyin' && ['PUT', 'DELETE'].includes(method)) {
    await saveConnection((saved, state) => {
      if (method === 'DELETE') delete saved.credentials.douyin;
      else {
        const value = z.object({ clientKey: z.string().trim().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/), clientSecret: z.string().trim().min(1).max(512), redirectUri: z.string().url().max(2048) }).strict().parse(body);
        const url = new URL(value.redirectUri);
        if (url.origin !== location.origin || url.pathname !== '/oauth/douyin/callback' || url.search || url.hash || url.username || url.password) throw new Error(`请在平台登记并填写 ${location.origin}/oauth/douyin/callback`);
        saved.credentials.douyin = JSON.stringify({ ...value, accounts: {} });
      }
      saved.authorizations = [];
      for (const account of state.accounts.filter(a => a.platform === 'douyin')) Object.assign(account, { connected: false, autoPublish: false, autoComments: false, note: '应用凭证已更新，请重新授权' });
      for (const p of state.projects) for (const pub of p.publications) { if (pub.automation?.status === 'queued') Object.assign(pub.automation, { status: 'blocked', error: '请重新授权并检查账号' }); if (pub.commentSync) pub.commentSync.enabled = false; }
    }); return integrationsOf(await readLocalState()) as T;
  }
  if (path === '/progress-version' && method === 'GET') {
    if (!onlineBusy) {
      const state = await readLocalState();
      if (!state.webPrivate?.pending) for (const p of state.projects) {
        if (p.assets.some(a => a.aiProduction?.phase === 'generating-video') || p.publications.some(r => ['queued', 'submitted'].includes(r.automation?.status || '') || r.commentSync?.enabled)) await relay('/tick', 'POST', {}, p.id);
      }
    }
    const state = await readLocalState(); return { version: state.projects.map(p => `${p.id}:${p.revision}`).join('|') } as T;
  }
  const online = path === '/settings/credential/check' || path.startsWith('/integrations/douyin/') || /^\/projects\/[^/]+\/(assets\/[^/]+\/(copy|keyframes|seedance|video-status|generation-reset)|publications\/[^/]+\/(automatic|stop-automatic|platform-status|platform-item|comments-sync)|comments\/classify)$/.test(path) || (body as { mode?: string })?.mode === 'openai';
  if (online) return await relay(path, method, body, path.startsWith('/projects/') ? path.split('/')[2] : undefined) as T;
  const result = await localAPI<unknown>(path, method, body);
  if (result && typeof result === 'object') {
    if ('schemaVersion' in result) return publicState(result as State) as T;
    if ('state' in result) return { ...result, state: publicState((result as { state: State }).state) } as T;
  }
  return result as T;
}
