import { z } from 'zod';
import { rulesOf, corpusQuery, searchCorpus, screenCopy } from './workflow.mjs';
import * as d from './domain.mjs';
import { MODELS, STAGES, createModelStore, stageConfig } from './models.mjs';
import { estimateReservation, generateStage, tokenCost, verifyModels } from './ai.mjs';

const loopback = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost', '[::1]'].includes(address);
export function isLocalClient(req) {
  try {
    const host = new URL(`http://${req.get('Host')}`).hostname;
    const origin = req.get('Origin');
    return loopback(req.socket.remoteAddress) && loopback(host) && (!origin || (loopback(new URL(origin).hostname) && ['http:', 'https:'].includes(new URL(origin).protocol))) && !req.get('Forwarded') && !req.get('X-Forwarded-For');
  } catch { return false; }
}
export const canUseCredentials = (req, config) => typeof config.authorizeCredentials === 'function' ? config.authorizeCredentials(req) === true : isLocalClient(req);

export function mountAIRoutes(app, store, config, { project, mutate, activeJobs }) {
  const requireLocal = req => d.assert(canUseCredentials(req, config), '请从已解锁的工作区使用自己的 API 密钥', 403);
  const models = config.modelStore || createModelStore();
  const vault = config.vault;
  let verification = null, settingsBusy = false;
  const vaultStatus = () => vault?.status() || { supported: false, configured: false, suffix: '', protection: '', problem: '' };
  const getKey = async req => { requireLocal(req); const status = vaultStatus(); d.assert(!status.problem, status.problem, 503); const key = status.configured ? await vault.getKey() : config.apiKey; d.assert(key, '请先在设置页保存 API 密钥'); return key; };
  const settings = req => {
    const v = vaultStatus(), local = canUseCredentials(req, config), routes = models.get(), strategy = stageConfig('strategy', routes);
    return { model: strategy.model, openaiConfigured: local && (v.configured || !!config.apiKey) && !v.problem, authEnabled: !!config.password || !!config.profileMode, inputPrice: strategy.inputPrice, outputPrice: strategy.outputPrice,
      version: '0.4.0', profileMode: !!config.profileMode, routes, models: MODELS, stages: STAGES, priceDate: '2026-09-12', verification: local ? verification : null,
      credential: { ...v, configured: v.configured || !!config.apiKey, suffix: local ? v.suffix : '', local, editable: local && v.supported, source: v.configured ? 'vault' : config.apiKey ? 'environment' : 'none' },
      capabilities: { image: 'gpt-image-2-keyframes', video: 'seedance-and-local', publishing: 'douyin-oauth-and-manual', comments: 'douyin-api-and-import', ai: ['strategy', 'planning', 'copy', 'classification', 'analysis'] } };
  };
  const changeSettings = async (req, res, work) => {
    requireLocal(req); d.assert(!settingsBusy && activeJobs.size === 0, '模型任务或设置操作正在进行，请完成后再修改配置', 409);
    settingsBusy = true;
    try { await work(); res.json(settings(req)); } finally { settingsBusy = false; }
  };
  app.get('/api/settings', (req, res) => res.json(settings(req)));
  app.put('/api/settings/credential', (req, res) => changeSettings(req, res, async () => {
    d.assert(vault?.status().supported, '此平台还未接入安全保险箱；没有保存密钥', 400);
    const { apiKey } = z.object({ apiKey: z.string().trim().regex(/^sk-[A-Za-z0-9_-]{16,509}$/, '请填写有效格式的 OpenAI API 密钥') }).strict().parse(req.body);
    await vault.save(apiKey); verification = null;
  }));
  app.delete('/api/settings/credential', (req, res) => changeSettings(req, res, async () => {
    d.assert(vault, '此平台没有本机密钥保险箱');
    vault.remove(); verification = null;
  }));
  app.post('/api/settings/credential/check', (req, res) => changeSettings(req, res, async () => {
    verification = null;
    verification = await verifyModels(await getKey(req), Object.values(models.get()), config.fetcher);
  }));
  app.put('/api/settings/models', (req, res) => changeSettings(req, res, async () => { models.save(req.body); verification = null; }));

  async function execute(req, res, stage, prepare, commit) {
    requireLocal(req);
    d.assert(!activeJobs.has(req.params.id) && !settingsBusy, '此项目正在执行模型任务或更新设置，请等待完成', 409);
    activeJobs.add(req.params.id);
    let jobId, reservation, payloadFingerprint, output;
    const route = stageConfig(stage, models.get());
    try {
      const apiKey = await getKey(req);
      const payload = prepare(project(store.get(), req.params.id));
      payloadFingerprint = JSON.stringify(payload);
      d.assert(Buffer.byteLength(JSON.stringify(payload)) <= 110000, '本次内容过长，请缩短资料或减少评论后再生成');
      reservation = estimateReservation(payload, route);
      store.mutate(state => {
        const p = project(state, req.params.id), spent = p.usage.reduce((sum, u) => sum + u.amountUsd, 0);
        d.assert(spent + reservation <= p.brief.budgetUsd, `余额不足。本次预留上限约 $${reservation.toFixed(3)}，请调整项目预算。`);
        jobId = d.id();
        p.usage.push({ id: jobId, stage, status: 'running', amountUsd: reservation, estimated: true, model: route.model, inputPrice: route.inputPrice, outputPrice: route.outputPrice, at: d.now(), note: `${route.label} · 请求进行中，预留费用` });
        d.touch(p);
      });
      output = await generateStage(payload, { ...route, apiKey }, config.fetcher);
      let stale = false;
      const result = store.mutate(state => {
        const p = project(state, req.params.id), usage = p.usage.find(u => u.id === jobId), cost = tokenCost(output.usage, route);
        Object.assign(usage, { status: 'completed', estimated: cost === null, amountUsd: cost ?? reservation, tokens: cost === null ? null : output.usage, note: `${route.label} · ${cost === null ? '未返回有效用量，保留预留金额' : '按返回 token 与本次模型单价估算，非最终账单'}` });
        // Background video polling and comment counters may touch the project without changing model inputs.
        try { stale = JSON.stringify(prepare(p)) !== payloadFingerprint; } catch { stale = true; }
        if (stale) { d.touch(p); return null; }
        const result = commit(p, output.value, route.model, payload, state); d.touch(p);
        d.activity(state, `${route.label}已生成`, `${route.model} · 请检查结果`, p.id); return result;
      });
      if (stale) return res.status(409).json({ error: '生成期间项目已修改，模型结果未覆盖新内容。费用已记录，请重新生成。' });
      res.json({ result, state: store.get() });
    } catch (error) {
      if (jobId) store.mutate(state => {
        const p = project(state, req.params.id), usage = p.usage.find(u => u.id === jobId);
        if (usage.status !== 'running') return;
        const cost = tokenCost(error.usage || output?.usage, route);
        Object.assign(usage, { status: error.noCharge ? 'failed' : 'uncertain', amountUsd: cost ?? (error.noCharge ? 0 : reservation), estimated: cost === null && !error.noCharge, note: error.noCharge ? '请求被拒绝，已释放预留费用' : '结果未完成；按返回用量或预留金额记录，请核对账单。' }); d.touch(p);
      });
      throw error;
    } finally { activeJobs.delete(req.params.id); }
  }
  app.post('/api/projects/:id/strategies', (req, res) => {
    const data = z.object({ mode: z.enum(['demo', 'openai']), stage: z.enum(['strategy', 'planning']).default('strategy'), instruction: z.string().trim().max(4000).default(''), query: z.string().trim().max(500).default('') }).parse(req.body);
    if (data.mode === 'demo') return mutate(req, res, (p, state) => { const s = d.makeDraft(p, {}, data.instruction, 'demo', rulesOf(state), data.query); d.activity(state, '策略草稿已生成', `V${s.version} · 检索语料并筛选文案`, p.id); return s; });
    return execute(req, res, data.stage, p => ({ brief: p.brief, instruction: data.instruction, retrievalQuery: data.query || corpusQuery(p, data.instruction), corpusReferences: searchCorpus(p, data.query || corpusQuery(p, data.instruction)), previousStrategy: p.strategies.at(-1), feedback: p.experiences.filter(e => e.active).map(e => ({ text: e.text, evidence: p.insights.find(i => i.id === e.insightId)?.evidenceIds.map(id => p.comments.find(c => c.id === id)?.text).filter(Boolean) || [] })) }), (p, value, model, payload, state) => { const s = d.makeDraft(p, value, '', 'openai', rulesOf(state), payload.retrievalQuery); s.model = model; s.stage = data.stage; return s; });
  });
  app.post('/api/projects/:id/assets/:assetId/copy', (req, res) => execute(req, res, 'copy', p => {
    const a = p.assets.find(a => a.id === req.params.assetId); d.assert(a, '内容不存在', 404);
    d.assert(a.revision === req.body.expectedRevision, '内容已更新，请刷新后再生成', 409);
    const s = p.strategies.find(s => s.id === a.strategyId); d.assert(s?.status === 'confirmed', '请先确认策略');
    const instruction = z.string().max(2000).parse(req.body.instruction || '');
    const retrievalQuery = corpusQuery(p, `${a.title} ${instruction}`);
    return { brief: s.briefSnapshot || p.brief, strategy: { title: s.title, core: s.core, direction: s.direction, prompt: s.prompt }, task: { channel: a.channel, kind: a.kind, title: a.title, body: a.body, prompt: a.prompt }, instruction, retrievalQuery, corpusReferences: searchCorpus(p, retrievalQuery) };
  }, (p, value, model, payload, state) => {
    const a = p.assets.find(a => a.id === req.params.assetId);
    const screened = screenCopy(value, rulesOf(state));
    d.updateAsset(p, a.id, { title: screened.value.title, body: screened.value.body, expectedRevision: a.revision }, rulesOf(state));
    Object.assign(a, { prompt: screened.value.prompt, scenes: screened.value.scenes, copyReview: screened.review, copyModel: model, status: 'queued', retrievalQuery: payload.retrievalQuery, corpusReferences: payload.corpusReferences }); return a;
  }));
  app.post('/api/projects/:id/comments/classify', (req, res) => execute(req, res, 'classification', p => {
    const comments = p.comments.filter(c => !c.irrelevant && !c.correctedAt && !c.classificationModel).slice(0, 60).map(c => ({ id: c.id, text: c.text }));
    d.assert(comments.length, '没有待分类评论；人工校正与已分类评论会保留'); return { comments };
  }, (p, value, model) => { for (const item of value.comments) Object.assign(p.comments.find(c => c.id === item.id), { tags: [...new Set(item.tags)], sentiment: item.sentiment, classificationModel: model }); return { count: value.comments.length }; }));
  app.post('/api/projects/:id/analysis', (req, res) => {
    const { mode } = z.object({ mode: z.enum(['demo', 'openai']).default('demo') }).parse(req.body || {});
    if (mode === 'demo') return mutate(req, res, (p, state) => { const result = d.analyzeComments(p); d.activity(state, '评论复盘已完成', `${result.length} 条建议 · 本地规则分析`, p.id); return result; });
    return execute(req, res, 'analysis', p => {
      const comments = p.comments.filter(c => !c.irrelevant).map(c => ({ id: c.id, text: c.text, tags: c.tags, sample: c.sample }));
      d.assert(comments.length > 0 && comments.length <= 200, 'AI 复盘当前支持 1–200 条有效评论，更多评论请使用本地规则分析'); return { brief: p.brief, comments };
    }, (p, value, model, payload) => {
      const analysisId = d.id(), comments = p.comments.filter(c => payload.comments.some(item => item.id === c.id)), times = comments.map(c => c.importedAt).sort();
      const insights = value.insights.map(item => { const evidenceIds = [...new Set(item.evidenceIds)]; return { ...item, evidenceIds, id: d.id(), analysisId, publicationIds: [...new Set(comments.filter(c => evidenceIds.includes(c.id)).map(c => c.publicationId))], sampleSize: comments.length, count: evidenceIds.length, provisional: comments.length < 30, status: 'pending', createdAt: d.now(), windowStart: times[0], windowEnd: times.at(-1), source: 'openai', model, scope: '仅限本项目已导入的有效评论；导入时间不代表评论发表时间；观察不等于因果。' }; });
      p.insights.push(...insights); return insights;
    });
  });
}
