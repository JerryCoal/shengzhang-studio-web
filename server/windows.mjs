import { resolve } from 'node:path';
import { createProfileApp } from './profiles.mjs';
const dataDirectory = process.env.STUDIO_DATA_DIR || resolve(process.env.LOCALAPPDATA || 'data', 'ShengzhangStudio');
const app = createProfileApp({ dataDirectory, staticDirectory: process.env.STUDIO_STATIC_DIR || resolve('dist'), allowedOrigins: ['http://127.0.0.1:5173', 'http://localhost:5173'] });
const server = app.listen(Number(process.env.PORT ?? 4319), '127.0.0.1', () => {
  const url = `http://127.0.0.1:${server.address().port}`;
  if (process.send) process.send({ event: 'ready', url });
  else console.log(`生长 Windows 完整版：${url}`);
});
let stopping = false;
async function shutdown() {
  if (stopping) return; stopping = true;
  server.close(); await app.locals.close(); process.exit(0);
}
server.on('error', () => { console.error('本地服务启动失败，请检查端口或数据目录权限。'); process.exit(1); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, shutdown);
process.on('message', message => { if (message?.event === 'shutdown') void shutdown(); });
process.on('disconnect', () => void shutdown());
