import { readFileSync } from 'node:fs';
import { atomicJSON } from './vault.mjs';
import { canUseCredentials } from './ai-routes.mjs';
import { assert } from './domain.mjs';
import { mountMediaGeneration, seedanceSettingsSchema, defaultSeedance } from './media-generation.mjs';
import { mountDouyin } from './douyin.mjs';
import { z } from 'zod';

export function createIntegrationPreferences(file) {
  let data = { seedance: { ...defaultSeedance } };
  if (file) try { const saved = JSON.parse(readFileSync(file, 'utf8')); data = { seedance: seedanceSettingsSchema.parse(saved.seedance) }; } catch (error) { if (error.code !== 'ENOENT') throw new Error('生成服务配置损坏，请检查 integration-settings.json'); }
  return { get: () => structuredClone(data), save(seedance) { const next = { seedance: seedanceSettingsSchema.parse(seedance) }; if (file) atomicJSON(file, next); data = next; } };
}
export function mountIntegrations(app, store, config, helpers) {
  const preferences = config.integrationPreferences || createIntegrationPreferences();
  const media = mountMediaGeneration(app, store, config, helpers, preferences);
  const douyin = mountDouyin(app, store, config, helpers);
  const local = req => assert(canUseCredentials(req, config), '请从已解锁的工作区设置连接', 403);
  const publicStatus = async req => {
    const local = canUseCredentials(req, config), v = config.seedanceVault?.status();
    return { local, seedance: { ...preferences.get().seedance, configured: !!v?.configured && !v.problem, supported: !!v?.supported, suffix: local ? v?.suffix || '' : '', problem: local ? v?.problem || '' : '' }, douyin: local ? await douyin.status() : { configured: false, supported: false, redirectUri: '', accounts: [] } };
  };
  app.get('/api/integrations', async (req, res) => res.json(await publicStatus(req)));
  app.put('/api/integrations/seedance', async (req, res) => {
    local(req); assert(!media.busy(), '请在生成任务完成后修改 Seedance 配置', 409);
    const { apiKey, ...settings } = seedanceSettingsSchema.extend({ apiKey: z.string().trim().min(8).max(512).regex(/^[A-Za-z0-9_.-]+$/).optional() }).strict().parse(req.body);
    if (apiKey) { assert(config.seedanceVault?.status().supported, '此系统尚未提供安全凭证保险箱'); await config.seedanceVault.save(apiKey); }
    preferences.save(settings); res.json(await publicStatus(req));
  });
  app.delete('/api/integrations/seedance', async (req, res) => { local(req); assert(!media.busy(), '请在生成任务完成后删除密钥', 409); config.seedanceVault?.remove(); res.json(await publicStatus(req)); });
  let timer, ticking = false, currentTick = Promise.resolve();
  const tick = () => {
    if (ticking) return currentTick;
    ticking = true;
    currentTick = Promise.allSettled([media.tick(), douyin.tick()]).finally(() => { ticking = false; });
    return currentTick;
  };
  return {
    tick,
    start() { media.recover(); douyin.recover(); timer = setInterval(tick, 10000); timer.unref(); },
    async close() { clearInterval(timer); douyin.close(); await currentTick; await media.close(); },
  };
}
