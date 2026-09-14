import { z } from 'zod';
import * as d from '../server/domain.mjs';
import { consumeEditorDraft, rulesOf, saveRules, importCorpus, changeCorpus, searchCorpus, saveEditorDraft, reviewObject } from '../server/workflow.mjs';
import { changeLocalState, lockLocalWorkspace, readLocalState } from './local-vault';
import modelSettings from './static-settings.json';
import type { State, Integrations, Settings, Project } from './types';

const unavailable = '静态体验版未连接在线服务。请在本地完整版中配置 AI 或平台授权；此处不会发出请求或收取费用。';
const settings: Settings = { ...modelSettings, openaiConfigured: false, authEnabled: true, version: '0.4.0 · 本地静态版', verification: null,
  credential: { local: false, editable: false, supported: false, configured: false, source: 'none', suffix: '', protection: '', problem: '静态版不接收 API 密钥。请在本地完整版中配置 AI 服务。' } } as Settings;
const integrations: Integrations = { local: false, seedance: { region: 'volcengine', model: '', reservationUsd: 2, outputPriceUsd: 0, configured: false, supported: false, suffix: '', problem: unavailable }, douyin: { configured: false, supported: false, redirectUri: '', accounts: [] } };
function project(state: State, id: string) { const p = state.projects.find(p => p.id === id); d.assert(p, '项目不存在'); return p; }
function sampleComments(p: Project) {
  d.assert(p.sample, '示例评论仅可添加到示例项目');
  let pub = p.publications.find(r => r.sample);
  if (!pub) {
    pub = { id: d.id(), assetId: '', assetRevision: 0, strategyId: p.strategies[0]?.id || '', accountId: 'sample', accountName: '示例账号', platform: 'xiaohongshu', title: '示例作品 · 周末去山野喝杯咖啡', body: '', mediaData: '', mime: '', status: 'published', confirmationSource: 'sample', sample: true, url: '', scheduledAt: d.now(), publishedAt: d.now() };
    p.publications.push(pub);
  }
  return d.importComments(p, { publicationId: pub.id, source: 'paste', text: '这个一包多大呀，可以放进随身小包吗？\n户外冲泡要带多少水？\n希望可以拍一个露营冲泡演示\n包装好喜欢，想知道怎么买\n一盒多少钱，有试喝装吗？\n可以展示一下实物大小吗\n上次喝了感觉不错，坚果风味喜欢\n价格有点贵，想了解和普通挂耳的区别\n希望拍一下实际装包的过程\n下雨天在家喝也很有氛围' });
}
export async function localAPI<T>(path: string, method: string, input: unknown): Promise<T> {
  if (path === '/health' && method === 'GET') return { ok: true, authRequired: false } as T;
  if (path === '/logout' && method === 'POST') { lockLocalWorkspace(); return { ok: true } as T; }
  if (method === 'GET') {
    const state = await readLocalState();
    if (path === '/state' || path === '/backup') { const copy = structuredClone(state); delete copy.webPrivate; return copy as T; }
    if (path === '/settings') return structuredClone(settings) as T;
    if (path === '/content-rules') return { rules: rulesOf(state), revision: state.rulesRevision || 0 } as T;
    if (path.startsWith('/editor-drafts/')) return (state.projectDrafts?.[path.split('/')[2]] || null) as T;
    if (path === '/integrations') return structuredClone(integrations) as T;
    if (path === '/progress-version') return { version: state.projects.map(p => `${p.id}:${p.revision}`).join('|') } as T;
    throw new Error(unavailable);
  }
  if (path.startsWith('/editor-drafts/')) {
    const key = path.split('/')[2];
    const result = await changeLocalState(state => {
      if (method === 'PUT') return saveEditorDraft(state, key, input, d.briefSchema);
      const body = input as { expectedVersion: number };
      const current = state.projectDrafts?.[key]; d.assert(!current || current.version === body.expectedVersion, '草稿已在另一处更新');
      if (current) delete state.projectDrafts![key]; return { ok: true };
    });
    return result.result as T;
  }
  if (/^\/projects\/[^/]+\/corpus\/search$/.test(path)) { const p = project(await readLocalState(), path.split('/')[2]); const query = z.string().max(500).parse((input as { query: string }).query); return { query, results: searchCorpus(p, query) } as T; }
  try {
    return await changeLocalState(state => {
      const body = z.record(z.string(), z.unknown()).parse(input ?? {});
      if (path === '/content-rules' && method === 'PUT') return saveRules(state, body);
      if (body.mode === 'openai' || path.startsWith('/integrations') || path.startsWith('/settings')) throw new Error(unavailable);
      if (path === '/projects' && method === 'POST') { const p = d.newProject(body); consumeEditorDraft(state, body); state.projects.unshift(p); d.activity(state, '新项目已创建', p.brief.name, p.id); return p; }
      const parts = path.split('/').filter(Boolean);
      if (parts[0] === 'accounts' && parts.length === 2 && method === 'PATCH') {
        const account = state.accounts.find(a => a.id === parts[1]); d.assert(account, '账号不存在'); account.name = z.string().trim().min(1).max(100).parse(body.name); return account;
      }
      if (parts[0] !== 'projects') throw new Error(unavailable);
      const p = project(state, parts[1]); const kind = parts[2], itemId = parts[3], action = parts[4];
      if (kind === 'corpus') { const result = method === 'POST' ? importCorpus(p, body) : changeCorpus(p, itemId, body, method); d.touch(p); return result; }
      if (parts.length === 2 && method === 'PATCH') {
        d.assert(p.revision === body.expectedRevision, '项目已更新，请重新打开后保存'); p.brief = d.briefSchema.parse(body.brief); d.touch(p); d.activity(state, '项目资料已更新', p.brief.name, p.id); return p;
      }
      if (kind === 'media' && method === 'PUT') {
        const data = z.object({ kind: z.enum(['image', 'audio']), data: z.string().max(12000000) }).parse(body);
        d.assert(data.data === '' || (data.kind === 'image' ? /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/ : /^data:audio\/(mpeg|wav|mp3|x-wav|mp4|ogg|webm);base64,[A-Za-z0-9+/=]+$/).test(data.data), '不支持此素材格式');
        p[data.kind === 'image' ? 'imageData' : 'audioData'] = data.data; d.touch(p); return { ok: true };
      }
      if (kind === 'strategies') {
        if (!itemId && method === 'POST') { const instruction = z.string().max(4000).default('').parse(body.instruction); const query = z.string().max(500).default('').parse(body.query); const s = d.makeDraft(p, {}, instruction, 'demo', rulesOf(state), query); d.activity(state, '策略草稿已生成', `V${s.version} · 语料检索与文案筛选`, p.id); return s; }
        if (action === 'confirm' && method === 'POST') { const s = d.confirmStrategy(p, itemId, rulesOf(state)); d.activity(state, '策略已确认，开始制作', `V${s.version} · ${s.tasks.length} 项制作任务`, p.id); return s; }
        if (!action && method === 'PATCH') return d.editStrategy(p, itemId, body, rulesOf(state));
      }
      if (kind === 'assets') {
        if (!action && method === 'PUT') return d.updateAsset(p, itemId, body, rulesOf(state));
        if (action === 'restore' && method === 'POST') { const asset = p.assets.find(a => a.id === itemId); const version = asset?.history.find(v => v.revision === body.revision); d.assert(asset && version?.mediaData, '该版本没有成品'); return d.updateAsset(p, itemId, { ...version, expectedRevision: asset.revision }, rulesOf(state)); }
        if (action === 'review' && method === 'POST') { const asset = p.assets.find(a => a.id === itemId); d.assert(asset, '内容不存在'); d.assert(asset.revision === body.expectedRevision, '成品已更新'); const old = JSON.stringify([asset.title, asset.body, asset.scenes, asset.prompt]), visual = JSON.stringify([asset.title, asset.scenes]); const prior = { title: asset.title, body: asset.body, mediaData: asset.mediaData, mime: asset.mime, revision: asset.revision, at: d.now() }, wasReady = asset.status === 'ready'; reviewObject(asset, rulesOf(state)); if (old !== JSON.stringify([asset.title, asset.body, asset.scenes, asset.prompt])) { if (wasReady) asset.history = [prior, ...asset.history].slice(0, 5); if (visual !== JSON.stringify([asset.title, asset.scenes])) asset.status = 'queued'; asset.revision++; d.touch(p); } return asset; }
      }
      if (kind === 'publications') {
        if (!itemId && method === 'POST') { const pub = d.schedulePublication(p, state.accounts, body); d.activity(state, '已加入发布计划', `${pub.title} · 等待手动发布`, p.id); return pub; }
        if (action === 'confirm' && method === 'POST') return d.confirmPublication(p, itemId, body);
        if (!action && method === 'PATCH') { const pub = p.publications.find(r => r.id === itemId); d.assert(pub && !['published', 'cancelled'].includes(pub.status), '此记录不可修改'); pub.status = z.enum(['exported', 'cancelled']).parse(body.status); d.touch(p); return pub; }
      }
      if (kind === 'comments') {
        if (itemId === 'import' && method === 'POST') { const r = d.importComments(p, body); d.activity(state, '评论已导入', `${r.added} 条新增`, p.id); return r; }
        if (itemId === 'sample' && method === 'POST') return sampleComments(p);
        if (!action && method === 'PATCH') { const c = p.comments.find(c => c.id === itemId); d.assert(c, '评论不存在'); const data = z.object({ tags: z.array(z.enum(d.categories)).min(1).optional(), sentiment: z.enum(['positive', 'neutral', 'negative']).optional(), irrelevant: z.boolean().optional() }).parse(body); Object.assign(c, data, { correctedAt: d.now() }); d.touch(p); return c; }
      }
      if (kind === 'analysis' && method === 'POST') return d.analyzeComments(p);
      if (kind === 'insights' && method === 'PATCH') return d.decideInsight(p, itemId, body);
      throw new Error(unavailable);
    }) as T;
  } catch (error) { if (error instanceof z.ZodError) throw new Error(`输入有误：${error.issues[0]?.message}`); throw error; }
}
