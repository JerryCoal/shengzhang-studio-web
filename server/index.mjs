import { createStore } from './store.mjs';
import { createApp } from './app.mjs';
import { createVault } from './vault.mjs';
import { createModelStore } from './models.mjs';
import { createIntegrationPreferences } from './integrations.mjs';
import { resolve, dirname } from 'node:path';
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 4318);
if (!['127.0.0.1', 'localhost', '::1'].includes(host) && (!process.env.APP_PASSWORD || process.env.APP_PASSWORD.length < 12)) {
  throw new Error('对外部署时请设置至少 12 位 APP_PASSWORD。');
}
const store = createStore(process.env.DB_PATH);
store.mutate(state => { for (const p of state.projects) for (const usage of p.usage) if (usage.status === 'running' && !p.assets.some(a => a.aiProduction?.videoUsageId === usage.id && a.aiProduction?.taskId && a.aiProduction.phase === 'generating-video')) { usage.status = 'uncertain'; usage.note = '服务重启时请求未完成，保留预留费用，请核对账单。'; } });
const dataDirectory = process.env.DB_PATH ? dirname(resolve(process.env.DB_PATH)) : resolve('data');
const app = createApp(store, {
  vault: createVault(resolve(dataDirectory, 'private/openai.dpapi.json')),
  seedanceVault: createVault(resolve(dataDirectory, 'private/seedance.dpapi.json')),
  douyinVault: createVault(resolve(dataDirectory, 'private/douyin.dpapi.json')),
  integrationPreferences: createIntegrationPreferences(resolve(dataDirectory, 'integration-settings.json')),
  modelStore: createModelStore(resolve(dataDirectory, 'model-settings.json')),
  apiKey: process.env.OPENAI_API_KEY || '', password: process.env.APP_PASSWORD || '',
  ...(process.env.SESSION_SECRET ? { secret: process.env.SESSION_SECRET } : {}),
  allowedOrigins: ['http://127.0.0.1:5173', 'http://localhost:5173', ...(process.env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean)],
});
const server = app.listen(port, host, error => {
  if (error) { console.error(`无法启动：端口 ${port} 可能正在被使用。请先停止旧服务。`); store.close(); process.exit(1); }
  console.log(`生长运营工作台：http://${host}:${port}`);
  app.locals.integrations.start();
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(async () => { await app.locals.integrations.close(); store.close(); process.exit(0); }));
