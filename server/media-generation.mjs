import { z } from 'zod';
import * as d from './domain.mjs';
import { canUseCredentials } from './ai-routes.mjs';
import { requestJSON, downloadVideo, integrationError } from './integration-http.mjs';

export const SEEDANCE_HOSTS = { volcengine: 'https://ark.cn-beijing.volces.com/api/v3', byteplus: 'https://ark.ap-southeast.bytepluses.com/api/v3' };
export const seedanceSettingsSchema = z.object({ region: z.enum(['volcengine', 'byteplus']), model: z.string().trim().min(3).max(120).regex(/^[a-zA-Z0-9_-]+$/), reservationUsd: z.number().min(0.1).max(100), outputPriceUsd: z.number().min(0).max(1000) }).strict();
export const defaultSeedance = { region: 'volcengine', model: '', reservationUsd: 2, outputPriceUsd: 0 };
const working = ['generating-frame', 'submitting-video', 'generating-video'];
const assetIn = (p, assetId) => { const a = p.assets.find(a => a.id === assetId); d.assert(a, '内容不存在', 404); return a; };

export function imageCost(usage) {
  const { text_tokens: text, image_tokens: images } = usage?.input_tokens_details || {};
  const output = usage?.output_tokens;
  return [text, images, output].every(n => Number.isFinite(n) && n >= 0) ? (text * 5 + images * 8 + output * 30) / 1e6 : null;
}
function reserve(p, model, amount, stage) {
  d.assert(p.usage.reduce((sum, u) => sum + u.amountUsd, 0) + amount <= p.brief.budgetUsd, `项目预算不足。本次需要预留 $${amount.toFixed(2)}，请先调整预算。`);
  const usage = { id: d.id(), stage, model, amountUsd: amount, estimated: true, status: 'running', at: d.now(), note: '请求费用预留；不代表服务商账单或单次收费上限' };
  p.usage.push(usage); return usage.id;
}
function settle(p, usageId, cost, status, note) {
  const usage = p.usage.find(u => u.id === usageId); if (!usage) return;
  Object.assign(usage, { amountUsd: cost ?? usage.amountUsd, estimated: cost === null, status, note });
}

export async function generateKeyframe({ apiKey, prompt, references = [], quality = 'medium' }, fetcher) {
  const body = { model: 'gpt-image-2', prompt, n: 1, size: '864x1536', quality, output_format: 'png' };
  let payload = JSON.stringify(body), headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, path = 'generations';
  if (references.length) {
    payload = new FormData(); for (const [key, value] of Object.entries(body)) payload.set(key, String(value));
    references.forEach((value, index) => { const mime = value.slice(5, value.indexOf(';')); payload.append('image[]', new Blob([Buffer.from(value.split(',')[1], 'base64')], { type: mime }), `reference-${index}.${mime.split('/')[1]}`); });
    delete headers['Content-Type']; path = 'edits';
  }
  const output = await requestJSON(`https://api.openai.com/v1/images/${path}`, { method: 'POST', headers, body: payload, timeout: 300000 }, fetcher, 'GPT Image 2', 24_000_000);
  const encoded = output.data?.[0]?.b64_json;
  if (typeof encoded !== 'string' || encoded.length > 12_000_000 || !/^[A-Za-z0-9+/=]+$/.test(encoded) || Buffer.from(encoded, 'base64').subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw integrationError('图片响应格式无效，未保存成关键帧', 502, { usage: output.usage });
  return { mediaData: `data:image/png;base64,${encoded}`, usage: output.usage };
}

export function mountMediaGeneration(app, store, config, { project, activeJobs }, preferences) {
  const local = req => d.assert(canUseCredentials(req, config), '请从已解锁的工作区使用自己的 API 密钥', 403);
  const fetcher = config.fetcher || fetch, pending = new Set(); let closing = false;
  const seedKey = async () => { const key = await config.seedanceVault?.getKey(); d.assert(key, '请在设置页保存 Seedance API Key'); return key; };
  const update = (projectId, assetId, cb) => store.mutate(state => { const p = project(state, projectId), a = assetIn(p, assetId); const result = cb(p, a, a.aiProduction); d.touch(p); return result; });
  const respond = res => res.status(202).json({ result: { accepted: true }, state: store.get() });
  const background = work => { const promise = work().catch(() => {}).finally(() => pending.delete(promise)); pending.add(promise); };

  app.post('/api/projects/:id/assets/:assetId/keyframes', async (req, res) => {
    local(req);
    const input = z.object({ role: z.enum(['first_frame', 'last_frame']), prompt: z.string().trim().min(1).max(4000), quality: z.enum(['low', 'medium', 'high']).default('medium'), expectedRevision: z.number().int() }).strict().parse(req.body);
    d.assert(!activeJobs.has(req.params.id), '此项目正在进行模型请求', 409);
    activeJobs.add(req.params.id);
    let key, job;
    try {
      key = config.vault?.status().configured ? await config.vault.getKey() : config.apiKey; d.assert(key, '请先配置 OpenAI API Key');
      const p = project(store.get(), req.params.id), a = assetIn(p, req.params.assetId);
      d.assert(a.kind === 'video' && a.revision === input.expectedRevision, '请刷新视频任务后再生成关键帧', 409);
      d.assert(!working.includes(a.aiProduction?.phase), '此内容有生成任务正在执行', 409);
      d.assert(a.aiProduction?.phase !== 'uncertain', '上次提交结果不明，请先核对控制台并解除该任务的锁定', 409);
      d.assert(!a.aiProduction?.taskId || a.aiProduction.phase === 'complete', '已有视频任务，请先核对并解除旧任务锁定', 409);
      const current = a.aiProduction?.assetRevision === a.revision ? a.aiProduction : { id: d.id(), assetRevision: a.revision, frames: [], phase: 'frames' };
      d.assert(input.role !== 'last_frame' || current.frames.some(f => f.role === 'first_frame'), '请先生成首帧');
      const strategy = p.strategies.find(s => s.id === a.strategyId); d.assert(strategy?.status === 'confirmed', '请先确认策略');
      const references = [p.imageData, ...(input.role === 'last_frame' ? [current.frames.find(f => f.role === 'first_frame').mediaData] : [])].filter(Boolean);
      const prompt = `为品牌视频生成${input.role === 'first_frame' ? '首帧' : '尾帧'}。保持参考图中的产品形状、包装、标识和场景连续性。不要编造产品事实。\n已确认资料：${JSON.stringify(strategy.briefSnapshot || p.brief)}\n画面要求：${input.prompt}`;
      job = update(p.id, a.id, (fresh, asset) => {
        const usageId = reserve(fresh, 'gpt-image-2', 1, 'keyframe');
        asset.aiProduction = { ...current, phase: 'generating-frame', error: '', frameUsageId: usageId };
        return { projectId: p.id, assetId: a.id, productionId: current.id, usageId, references, prompt };
      });
    } finally { activeJobs.delete(req.params.id); }
    background(async () => {
      try {
        const result = await generateKeyframe({ apiKey: key, prompt: job.prompt, references: job.references, quality: input.quality }, fetcher);
        update(job.projectId, job.assetId, (p, a, g) => {
          settle(p, job.usageId, imageCost(result.usage), 'completed', 'GPT Image 2 · 按返回 token 估算，最终以账单为准');
          if (g?.id !== job.productionId) return;
          g.frames = g.frames.filter(f => input.role === 'last_frame' && f.role === 'first_frame');
          g.frames.push({ id: d.id(), role: input.role, prompt: input.prompt, mediaData: result.mediaData, model: 'gpt-image-2', createdAt: d.now() });
          g.phase = a.revision === g.assetRevision ? 'frames' : 'stale';
          g.error = g.phase === 'stale' ? '内容已修改，关键帧保留供查看，请按新版本重新生成。' : '';
        });
      } catch (error) {
        update(job.projectId, job.assetId, (p, _a, g) => { settle(p, job.usageId, imageCost(error.usage) ?? (error.noCharge ? 0 : null), error.noCharge ? 'failed' : 'uncertain', '关键帧未完成，请核对服务商账单'); if (g?.id === job.productionId) { g.phase = error.noCharge ? 'failed' : 'uncertain'; g.error = error.status ? error.message : '关键帧未完成，请核对控制台。'; } });
      }
    });
    respond(res);
  });

  app.post('/api/projects/:id/assets/:assetId/seedance', async (req, res) => {
    local(req);
    const input = z.object({ productionId: z.string(), expectedRevision: z.number().int(), prompt: z.string().trim().min(1).max(4000), duration: z.union([z.literal(5), z.literal(8), z.literal(12)]), generateAudio: z.boolean(), confirmed: z.literal(true) }).strict().parse(req.body);
    const settings = seedanceSettingsSchema.parse(preferences.get().seedance);
    const key = await seedKey();
    const job = update(req.params.id, req.params.assetId, (p, a, g) => {
      d.assert(a.revision === input.expectedRevision && g?.assetRevision === a.revision && g.id === input.productionId, '内容版本已改变，请重新检查关键帧', 409);
      d.assert(['frames', 'failed'].includes(g.phase) && !g.taskId, '任务已经提交或需要先核对结果，请勿重复生成', 409);
      d.assert(g.frames.length === 2 && g.frames.some(f => f.role === 'first_frame') && g.frames.some(f => f.role === 'last_frame'), '请先完成首尾两张关键帧');
      const usageId = reserve(p, settings.model, settings.reservationUsd, 'video');
      Object.assign(g, { phase: 'submitting-video', prompt: input.prompt, duration: input.duration, generateAudio: input.generateAudio, videoUsageId: usageId, provider: settings.region, model: settings.model, outputPriceUsd: settings.outputPriceUsd, error: '', submittedAt: d.now(), failures: 0 });
      return { projectId: p.id, assetId: a.id, productionId: g.id, frames: g.frames, usageId };
    });
    background(async () => {
      try {
        const value = await requestJSON(`${SEEDANCE_HOSTS[settings.region]}/contents/generations/tasks`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: settings.model, content: [{ type: 'text', text: input.prompt }, ...job.frames.map(f => ({ type: 'image_url', image_url: { url: f.mediaData }, role: f.role }))], duration: input.duration, ratio: 'adaptive', resolution: '720p', generate_audio: input.generateAudio, watermark: true }) }, fetcher, 'Seedance');
        d.assert(typeof value.id === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value.id), 'Seedance 未返回任务编号，请核对控制台后再操作', 502);
        update(job.projectId, job.assetId, (_p, _a, g) => { if (g?.id === job.productionId) Object.assign(g, { taskId: value.id, phase: 'generating-video', nextPollAt: Date.now() + 10000 }); });
      } catch (error) {
        update(job.projectId, job.assetId, (p, _a, g) => { settle(p, job.usageId, error.noCharge ? 0 : null, error.noCharge ? 'failed' : 'uncertain', 'Seedance 提交未完成，请核对控制台，未自动重试'); if (g?.id === job.productionId) Object.assign(g, { phase: error.noCharge ? 'failed' : 'uncertain', error: error.status ? error.message : '提交结果不明，请核对控制台。' }); });
      }
    });
    respond(res);
  });

  const pollLocks = new Set();
  async function poll(projectId, assetId) {
    const lock = `${projectId}/${assetId}`; if (pollLocks.has(lock)) return; pollLocks.add(lock);
    const original = assetIn(project(store.get(), projectId), assetId).aiProduction;
    try {
      d.assert(original?.taskId, '没有可查询的视频任务');
      if (original.phase === 'complete') return;
      const value = await requestJSON(`${SEEDANCE_HOSTS[original.provider]}/contents/generations/tasks/${encodeURIComponent(original.taskId)}`, { method: 'GET', headers: { Authorization: `Bearer ${await seedKey()}` }, timeout: 30000 }, fetcher, 'Seedance');
      d.assert(value.id === original.taskId, 'Seedance 返回的任务编号不匹配', 502);
      const tokens = value.usage?.completion_tokens;
      const cost = Number.isFinite(tokens) && tokens >= 0 && original.outputPriceUsd > 0 ? tokens * original.outputPriceUsd / 1e6 : null;
      if (value.status === 'succeeded') {
        // Record model usage even if downloading fails; read-only polling can safely retry the download.
        update(projectId, assetId, (p) => settle(p, original.videoUsageId, cost, 'completed', 'Seedance 已完成；按配置单价与返回 token 估算，未配置单价则保留费用预留'));
        const mediaData = await (config.downloadVideo || downloadVideo)(value.content?.video_url, fetcher);
        update(projectId, assetId, (p, a, g) => {
          if (g?.id !== original.id) return;
          if (a.revision !== g.assetRevision) { g.phase = 'stale'; g.error = '视频已生成，但内容版本已修改。成品已保存在此任务，检查后可另行保存。'; g.resultMediaData = mediaData; return; }
          d.updateAsset(p, a.id, { title: a.title, body: a.body, mediaData, mime: 'video/mp4', expectedRevision: a.revision });
          g.phase = 'complete'; g.error = ''; g.completedAt = d.now();
        });
      } else if (['failed', 'cancelled', 'expired'].includes(value.status)) {
        update(projectId, assetId, (p, _a, g) => { settle(p, original.videoUsageId, cost, 'failed', '视频任务未完成，费用以服务商账单为准'); Object.assign(g, { phase: 'failed', error: 'Seedance 任务未完成，请检查服务商控制台；需要核对后再创建新任务。' }); });
      } else {
        d.assert(['running', 'queued'].includes(value.status), '无法识别 Seedance 任务状态', 502);
        update(projectId, assetId, (_p, _a, g) => Object.assign(g, { phase: 'generating-video', nextPollAt: Date.now() + 20000, error: '', failures: 0 }));
      }
    } catch (error) {
      update(projectId, assetId, (_p, _a, g) => { g.failures = (g.failures || 0) + 1; g.nextPollAt = Date.now() + Math.min(300000, 20000 * 2 ** Math.min(g.failures, 4)); g.error = error.status ? error.message : '暂时无法查询视频，请稍后重试。'; if (g.failures >= 8) g.phase = 'uncertain'; });
    } finally { pollLocks.delete(lock); }
  }
  app.post('/api/projects/:id/assets/:assetId/video-status', async (req, res) => { local(req); await poll(req.params.id, req.params.assetId); res.json({ result: { checked: true }, state: store.get() }); });
  app.post('/api/projects/:id/assets/:assetId/generation-reset', (req, res) => {
    local(req); z.object({ confirmed: z.literal(true) }).strict().parse(req.body);
    update(req.params.id, req.params.assetId, (_p, _a, g) => { d.assert(g && !working.includes(g.phase), '任务仍在执行，不能解除锁定', 409); g.taskHistory = [...(g.taskHistory || []), { taskId: g.taskId || '', phase: g.phase, at: d.now() }].slice(-10); delete g.taskId; g.phase = 'frames'; g.error = ''; });
    res.json({ result: { reset: true }, state: store.get() });
  });
  return {
    recover() { store.mutate(state => { for (const p of state.projects) for (const a of p.assets) if (['generating-frame', 'submitting-video'].includes(a.aiProduction?.phase)) { a.aiProduction.phase = 'uncertain'; a.aiProduction.error = '服务重启前的提交结果不明。请核对控制台，未自动重复调用。'; } }); },
    async tick() { if (closing) return; for (const p of store.get().projects) for (const a of p.assets) if (a.aiProduction?.phase === 'generating-video' && a.aiProduction.nextPollAt <= Date.now()) await poll(p.id, a.id); },
    async close() { closing = true; await Promise.allSettled([...pending]); },
    busy: () => pending.size > 0 || pollLocks.size > 0 || store.get().projects.some(p => p.assets.some(a => working.includes(a.aiProduction?.phase))),
  };
}
