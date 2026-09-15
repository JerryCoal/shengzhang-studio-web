import express from 'express';
import JSZip from 'jszip';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';
import * as domain from './domain.mjs';
import { mountAIRoutes } from './ai-routes.mjs';
import { createOpenAITransport } from './openai-errors.mjs';
import { createDeepSeekTransport } from './deepseek.mjs';
import { mountIntegrations } from './integrations.mjs';
import { consumeEditorDraft, rulesOf, saveRules, importCorpus, changeCorpus, searchCorpus, saveEditorDraft, reviewObject } from './workflow.mjs';

export function createApp(store, options = {}) {
  const app = express();
  const config = { apiKey: '', password: '', secret: randomBytes(32).toString('hex'), allowedOrigins: [], ...options };
  const openaiTransport = createOpenAITransport(config.fetcher);
  const deepseekTransport = createDeepSeekTransport(openaiTransport.fetch);
  config.fetcher = deepseekTransport.fetch;
  config.deepseekTransport = app.locals.deepseekTransport = deepseekTransport;
  config.openaiTransport = app.locals.openaiTransport = openaiTransport;
  const sessionHash = value => createHmac('sha256', config.secret).update(value).digest('hex');
  const sessions = new Map();
  const loginAttempts = new Map();
  const activeJobs = new Set();
  app.locals.activeJobs = activeJobs;
  const downloads = new Map();
  app.locals.hasDownload = ticket => { const item = downloads.get(ticket); return !!item && item.expiresAt > Date.now(); };
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    if (req.path.startsWith('/api')) {
      res.set('Cache-Control', 'no-store');
      const origin = req.get('Origin');
      const self = `${req.protocol}://${req.get('Host')}`;
      const allowed = !origin || origin === self || config.allowedOrigins.includes(origin);
      if (!allowed) return res.status(403).json({ error: '此来源未获允许' });
      if (origin && config.allowedOrigins.includes(origin)) {
        res.set('Access-Control-Allow-Origin', origin); res.vary('Origin');
        res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Studio-Client');
        res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
      }
      if (req.method === 'OPTIONS') return res.sendStatus(204);
    }
    next();
  });
  app.use(express.json({ limit: '32mb' }));
  app.get('/api/health', (_req, res) => res.json({ ok: true, authRequired: !!config.password }));
  app.post('/api/login', (req, res) => {
    const address = req.ip;
    const attempt = loginAttempts.get(address) || { count: 0, at: Date.now() };
    if (Date.now() - attempt.at > 15 * 60 * 1000) { attempt.count = 0; attempt.at = Date.now(); }
    if (attempt.count >= 10) return res.status(429).json({ error: '尝试次数过多，请 15 分钟后重试' });
    const value = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!config.password || !timingSafeEqual(Buffer.from(sessionHash(value)), Buffer.from(sessionHash(config.password)))) {
      attempt.count += 1; loginAttempts.set(address, attempt);
      return res.status(401).json({ error: '工作区密码不正确' });
    }
    loginAttempts.delete(address);
    for (const [key, expiry] of sessions) if (expiry < Date.now()) sessions.delete(key);
    const token = randomBytes(32).toString('base64url');
    sessions.set(sessionHash(token), Date.now() + 7 * 86400000);
    res.json({ token });
  });
  app.use('/api', (req, res, next) => {
    if (req.get('X-Studio-Client') !== 'studio-v1') return res.status(403).json({ error: '请从运营工作台访问' });
    if (config.password) {
      const token = (req.get('Authorization') || '').replace(/^Bearer /, '');
      if ((sessions.get(sessionHash(token)) || 0) < Date.now()) return res.status(401).json({ error: '请登录工作区' });
    }
    next();
  });
  app.post('/api/logout', (req, res) => { sessions.delete(sessionHash((req.get('Authorization') || '').replace(/^Bearer /, ''))); res.json({ ok: true }); });
  const project = (state, projectId) => { const p = state.projects.find(p => p.id === projectId); domain.assert(p, '项目不存在', 404); return p; };
  const mutate = (req, res, callback) => {
    const result = store.mutate(state => { const p = project(state, req.params.id); return callback(p, state); });
    res.json({ result, state: store.get() });
  };
  app.get('/api/state', (_req, res) => res.json(store.get()));
  app.get('/api/content-rules', (_req, res) => { const state = store.get(); res.json({ rules: rulesOf(state), revision: state.rulesRevision || 0 }); });
  app.put('/api/content-rules', (req, res) => { const result = store.mutate(state => saveRules(state, req.body)); res.json({ result, state: store.get() }); });
  app.get('/api/editor-drafts/:key', (req, res) => res.json(store.get().projectDrafts?.[req.params.key] || null));
  app.put('/api/editor-drafts/:key', (req, res) => res.json(store.mutate(state => saveEditorDraft(state, req.params.key, req.body, domain.briefSchema))));
  app.delete('/api/editor-drafts/:key', (req, res) => {
    store.mutate(state => { const current = state.projectDrafts?.[req.params.key]; domain.assert(!current || current.version === req.body.expectedVersion, '草稿已在另一处更新', 409); if (current) delete state.projectDrafts[req.params.key]; }); res.json({ ok: true });
  });
  app.post('/api/projects/:id/corpus', (req, res) => mutate(req, res, p => { const result = importCorpus(p, req.body); domain.touch(p); return result; }));
  app.patch('/api/projects/:id/corpus/:documentId', (req, res) => mutate(req, res, p => { const result = changeCorpus(p, req.params.documentId, req.body, 'PATCH'); domain.touch(p); return result; }));
  app.delete('/api/projects/:id/corpus/:documentId', (req, res) => mutate(req, res, p => { const result = changeCorpus(p, req.params.documentId, {}, 'DELETE'); domain.touch(p); return result; }));
  app.post('/api/projects/:id/corpus/search', (req, res) => {
    const { query } = z.object({ query: z.string().trim().max(500) }).parse(req.body);
    res.json({ query, results: searchCorpus(project(store.get(), req.params.id), query) });
  });
  app.post('/api/projects/:id/assets/:assetId/review', (req, res) => mutate(req, res, (p, state) => {
    const asset = p.assets.find(a => a.id === req.params.assetId); domain.assert(asset, '内容不存在', 404);
    domain.assert(asset.revision === req.body.expectedRevision, '成品已更新，请重新打开', 409);
    const previous = JSON.stringify([asset.title, asset.body, asset.scenes, asset.prompt]);
    const visual = JSON.stringify([asset.title, asset.scenes]); const old = { title: asset.title, body: asset.body, mediaData: asset.mediaData, mime: asset.mime, revision: asset.revision, at: domain.now() }; const wasReady = asset.status === 'ready'; reviewObject(asset, rulesOf(state));
    if (previous !== JSON.stringify([asset.title, asset.body, asset.scenes, asset.prompt])) { if (wasReady) asset.history = [old, ...asset.history].slice(0, 5); if (visual !== JSON.stringify([asset.title, asset.scenes])) asset.status = 'queued'; asset.revision++; domain.touch(p); }
    return asset;
  }));
  app.get('/api/progress-version', (_req, res) => res.json({ version: store.get().projects.map(p => `${p.id}:${p.revision}`).join('|') }));
  mountAIRoutes(app, store, config, { project, mutate, activeJobs });
  app.locals.integrations = mountIntegrations(app, store, config, { project, mutate, activeJobs });
  app.get('/api/backup', (_req, res) => res.set('Content-Disposition', 'attachment; filename="shengzhang-backup.json"').json(store.get()));
  app.post('/api/projects/:id/export', async (req, res) => {
    const data = z.object({ kind: z.enum(['asset', 'publication']), id: z.string() }).parse(req.body);
    const p = project(store.get(), req.params.id);
    const content = (data.kind === 'asset' ? p.assets : p.publications).find(item => item.id === data.id);
    domain.assert(content?.mediaData, '请先制作素材', 400);
    domain.assert(data.kind !== 'asset' || content.status === 'ready', '当前内容需要重新制作');
    const zip = new JSZip();
    const extension = content.mime === 'image/png' ? 'png' : content.mime === 'video/mp4' ? 'mp4' : 'webm';
    zip.file(`素材.${extension}`, content.mediaData.split(',')[1], { base64: true });
    zip.file('标题与正文.txt', `${content.title}\n\n${content.body}`);
    zip.file('发布说明.txt', `此素材包尚未自动发布。请检查产品事实，在对应平台发布后回填作品链接。${extension === 'webm' ? '\n此视频为 WebM，如果平台不接受，请先转换为 MP4。' : ''}`);
    const bytes = await zip.generateAsync({ type: 'nodebuffer' });
    for (const [key, value] of downloads) if (value.expiresAt < Date.now()) downloads.delete(key);
    while (downloads.size >= 12) downloads.delete(downloads.keys().next().value);
    const ticket = randomBytes(32).toString('base64url');
    const filename = `${content.title.replace(/[\\/:*?"<>|]/g, '').slice(0, 40) || '宣传内容'}-素材包.zip`;
    downloads.set(ticket, { bytes, filename, expiresAt: Date.now() + 5 * 60000 });
    res.json({ url: `/downloads/${ticket}`, filename });
  });
  app.post('/api/projects', (req, res) => {
    const p = store.mutate(state => { const p = domain.newProject(req.body); consumeEditorDraft(state, req.body); state.projects.unshift(p); domain.activity(state, '新项目已创建', p.brief.name, p.id); return p; });
    res.status(201).json({ result: p, state: store.get() });
  });
  app.patch('/api/projects/:id', (req, res) => mutate(req, res, (p, state) => {
    const data = z.object({ brief: domain.briefSchema, expectedRevision: z.number().int() }).parse(req.body);
    domain.assert(p.revision === data.expectedRevision, '项目已更新，请刷新后再保存', 409);
    p.brief = data.brief; domain.touch(p); domain.activity(state, '项目资料已更新', '已确认策略保留原版；新策略将使用更新后的资料。', p.id); return p;
  }));
  app.put('/api/projects/:id/media', (req, res) => mutate(req, res, p => {
    const data = z.object({ kind: z.enum(['image', 'audio']), data: z.string().max(12000000) }).parse(req.body);
    domain.assert(data.data === '' || (data.kind === 'image' ? /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/ : /^data:audio\/(mpeg|wav|mp3|x-wav|mp4|ogg|webm);base64,[A-Za-z0-9+/=]+$/).test(data.data), '不支持此素材格式');
    p[data.kind === 'image' ? 'imageData' : 'audioData'] = data.data; domain.touch(p); return { ok: true };
  }));
  app.patch('/api/projects/:id/strategies/:strategyId', (req, res) => mutate(req, res, (p, state) => domain.editStrategy(p, req.params.strategyId, req.body, rulesOf(state))));
  app.post('/api/projects/:id/strategies/:strategyId/confirm', (req, res) => mutate(req, res, (p, state) => {
    const s = domain.confirmStrategy(p, req.params.strategyId, rulesOf(state)); domain.activity(state, '策略已确认，开始制作', `V${s.version} · ${s.tasks.length} 项制作任务`, p.id); return s;
  }));
  app.put('/api/projects/:id/assets/:assetId', (req, res) => mutate(req, res, (p, state) => domain.updateAsset(p, req.params.assetId, req.body, rulesOf(state))));
  app.post('/api/projects/:id/assets/:assetId/restore', (req, res) => mutate(req, res, (p, state) => {
    const a = p.assets.find(a => a.id === req.params.assetId); domain.assert(a, '内容不存在', 404);
    const old = a.history.find(h => h.revision === req.body.revision); domain.assert(old?.mediaData, '该版本没有成品');
    return domain.updateAsset(p, a.id, { title: old.title, body: old.body, mediaData: old.mediaData, mime: old.mime, expectedRevision: a.revision }, rulesOf(state));
  }));
  app.post('/api/projects/:id/publications', (req, res) => mutate(req, res, (p, state) => {
    const pub = domain.schedulePublication(p, state.accounts, req.body); domain.activity(state, '已加入发布计划', `${pub.title} · 等待手动发布`, p.id); return pub;
  }));
  app.post('/api/projects/:id/publications/:publicationId/confirm', (req, res) => mutate(req, res, (p, state) => {
    const pub = domain.confirmPublication(p, req.params.publicationId, req.body); domain.activity(state, '作品发布结果已登记', `${pub.title} · 用户回填确认`, p.id); return pub;
  }));
  app.patch('/api/projects/:id/publications/:publicationId', (req, res) => mutate(req, res, p => {
    const pub = p.publications.find(r => r.id === req.params.publicationId); domain.assert(pub, '记录不存在', 404);
    domain.assert(!['published', 'cancelled'].includes(pub.status), '该记录不可修改');
    domain.assert(!pub.automation || ['cancelled', 'blocked', 'failed'].includes(pub.automation.status), '请先停止自动发布计划；已开始的投稿需在平台核对', 409);
    const data = z.object({ status: z.enum(['exported', 'cancelled']) }).parse(req.body);
    pub.status = data.status; domain.touch(p); return pub;
  }));
  app.post('/api/projects/:id/comments/import', (req, res) => mutate(req, res, (p, state) => {
    const result = domain.importComments(p, req.body); domain.activity(state, '评论已导入', `${result.added} 条新增，${result.duplicates} 条重复已跳过`, p.id); return result;
  }));
  app.post('/api/projects/:id/comments/sample', (req, res) => mutate(req, res, p => {
    domain.assert(p.sample, '示例评论仅可添加到示例项目');
    let pub = p.publications.find(r => r.sample);
    if (!pub) {
      pub = { id: domain.id(), assetId: '', assetRevision: 0, strategyId: p.strategies[0]?.id || '', accountId: 'sample', accountName: '示例账号', platform: 'xiaohongshu',
        title: '示例作品 · 周末去山野喝杯咖啡', body: '', mediaData: '', mime: '', status: 'published', confirmationSource: 'sample', sample: true, url: '', scheduledAt: domain.now(), publishedAt: domain.now(), createdAt: domain.now() };
      p.publications.push(pub);
    }
    return domain.importComments(p, { publicationId: pub.id, source: 'paste', text: '这个一包多大呀，可以放进随身小包吗？\n户外冲泡要带多少水？\n希望可以拍一个露营冲泡演示\n包装好喜欢，想知道怎么买\n一盒多少钱，有试喝装吗？\n可以展示一下实物大小吗\n上次喝了感觉不错，坚果风味喜欢\n价格有点贵，想了解和普通挂耳的区别\n希望拍一下实际装包的过程\n下雨天在家喝也很有氛围' });
  }));
  app.patch('/api/projects/:id/comments/:commentId', (req, res) => mutate(req, res, p => {
    const c = p.comments.find(c => c.id === req.params.commentId); domain.assert(c, '评论不存在', 404);
    const data = z.object({ tags: z.array(z.enum(domain.categories)).min(1).optional(), sentiment: z.enum(['positive', 'neutral', 'negative']).optional(), irrelevant: z.boolean().optional() }).parse(req.body);
    Object.assign(c, data, { correctedAt: domain.now() }); domain.touch(p); return c;
  }));
  app.patch('/api/projects/:id/insights/:insightId', (req, res) => mutate(req, res, p => domain.decideInsight(p, req.params.insightId, req.body)));
  app.patch('/api/accounts/:accountId', (req, res) => {
    const data = z.object({ name: z.string().trim().min(1).max(100) }).parse(req.body);
    store.mutate(state => { const a = state.accounts.find(a => a.id === req.params.accountId); domain.assert(a, '账号不存在', 404); a.name = data.name; });
    res.json({ state: store.get() });
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在' }));
  app.get('/downloads/:ticket', (req, res) => {
    const item = downloads.get(req.params.ticket);
    if (!item || item.expiresAt < Date.now()) return res.status(404).send('下载链接已过期，请返回工作台重新导出。');
    res.set('Cache-Control', 'no-store');
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="content.zip"; filename*=UTF-8''${encodeURIComponent(item.filename)}`);
    res.send(item.bytes);
  });
  app.use(express.static(config.staticDirectory || resolve('dist'), { index: false }));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve(config.staticDirectory || 'dist', 'index.html')));
  app.use((error, _req, res, _next) => {
    if (error instanceof z.ZodError) return res.status(400).json({ error: `输入有误：${error.issues[0]?.path.join('.')} ${error.issues[0]?.message}` });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: '文件过大，请使用较小的素材' });
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: '请求数据格式错误' });
    if (!error.status) console.error('Request failed: internal error');
    res.status(error.status || 500).json({ error: error.status ? error.message : '服务暂时遇到问题，请重试。数据已保留。', ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}) });
  });
  return app;
}
