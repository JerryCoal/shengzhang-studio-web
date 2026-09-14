import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { pbkdf2, randomBytes, randomUUID, createHmac, createHash, timingSafeEqual, hkdfSync } from 'node:crypto';
import { createStore } from './store.mjs';
import { createApp } from './app.mjs';
import { createVault, dpapi } from './vault.mjs';
import { createModelStore } from './models.mjs';
import { createIntegrationPreferences } from './integrations.mjs';
import { isLocalClient } from './ai-routes.mjs';
import { seal, unseal } from './crypto-box.mjs';

const derive = promisify(pbkdf2);
const hash = value => createHash('sha256').update(value).digest('hex');
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const SESSION_MS = 12 * 60 * 60 * 1000;

export function createProfileApp(options) {
  const { dataDirectory, staticDirectory = resolve('dist'), allowedOrigins = [], transform = dpapi, vaultSupported = process.platform === 'win32' } = options;
  mkdirSync(dataDirectory, { recursive: true });
  const db = new DatabaseSync(resolve(dataDirectory, 'users.sqlite'));
  db.exec('PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, salt BLOB NOT NULL, verifier BLOB NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS remembered_users (user_id TEXT PRIMARY KEY, protected_key BLOB NOT NULL, updated_at TEXT NOT NULL)');
  const contexts = new Map(), sessions = new Map(), attempts = new Map();
  let authenticating = 0, shuttingDown = false;
  const app = express(); app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self' data: blob:; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'" });
    if (!isLocalClient(req)) return res.status(403).json({ error: '此应用仅允许在运行服务的电脑上访问' });
    const origin = req.get('Origin'), self = `${req.protocol}://${req.get('Host')}`;
    if (origin && origin !== self && !allowedOrigins.includes(origin)) return res.status(403).json({ error: '此来源未获允许' });
    if (origin && allowedOrigins.includes(origin)) { res.set({ 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Studio-Client', 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS' }); res.vary('Origin'); }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    if (req.path.startsWith('/api')) res.set('Cache-Control', 'no-store');
    if (shuttingDown) return res.status(503).json({ error: '应用正在关闭，请稍后重新打开' });
    next();
  });
  app.use(express.json({ limit: '32mb' }));
  app.get('/api/health', (_req, res) => res.json({ ok: true, authRequired: true, authMode: 'profiles', version: '0.4.1', localOnly: true }));
  app.use('/api', (req, res, next) => req.get('X-Studio-Client') === 'studio-v1' ? next() : res.status(403).json({ error: '请从运营工作台访问' }));
  const tokenHash = req => hash((req.get('Authorization') || '').replace(/^Bearer /, ''));
  const identity = req => { const value = sessions.get(tokenHash(req)); if (!value || value.expiresAt <= Date.now()) throw failure('请重新登录本地工作区', 401); return value; };
  const makeSession = user => { const token = randomBytes(32).toString('base64url'); sessions.set(hash(token), { userId: user.id, username: user.name, expiresAt: Date.now() + SESSION_MS }); return { token, username: user.name }; };
  function openWorkspace(user, masterKey) {
    const cached = contexts.get(user.id);
    if (cached) { masterKey.fill(0); if (cached.closing) throw failure('该工作区正在退出，请稍候重新登录', 409); return; }
    const directory = resolve(dataDirectory, 'profiles', user.id);
    const workspaceKey = Buffer.from(hkdfSync('sha256', masterKey, user.id, 'workspace', 32));
    const credentialKey = Buffer.from(hkdfSync('sha256', masterKey, user.id, 'credentials', 32));
    masterKey.fill(0);
    let store;
    try {
      store = createStore(resolve(directory, 'workspace.sqlite'), { key: workspaceKey, scope: user.id });
      store.mutate(state => { for (const p of state.projects) for (const usage of p.usage) if (usage.status === 'running' && !p.assets.some(a => a.aiProduction?.videoUsageId === usage.id && a.aiProduction?.taskId && a.aiProduction.phase === 'generating-video')) { usage.status = 'uncertain'; usage.note = '上次运行中断，请核对服务商账单；已保留预留费用。'; } });
      const vault = name => createVault(resolve(directory, 'private', `${name}.json`), { supported: vaultSupported, transform: async (action, bytes) => {
        if (action === 'protect') {
          const encrypted = seal(bytes, credentialKey, `${user.id}:${name}`);
          try { return await transform('protect', encrypted); } finally { encrypted.fill(0); }
        }
        const protectedBytes = await transform('unprotect', bytes);
        try { return unseal(protectedBytes, credentialKey, `${user.id}:${name}`); } finally { protectedBytes.fill(0); }
      } });
      const workspaceApp = createApp(store, { ...options.workspaceOptions, profileMode: true, staticDirectory, allowedOrigins, vault: vault('openai'), seedanceVault: vault('seedance'), douyinVault: vault('douyin'), modelStore: createModelStore(resolve(directory, 'models.json')), integrationPreferences: createIntegrationPreferences(resolve(directory, 'integrations.json')) });
      const context = { app: workspaceApp, store, credentialKey, active: 0, idle: [], closing: null };
      contexts.set(user.id, context); workspaceApp.locals.integrations.start();
    } catch (error) { store?.close(); credentialKey.fill(0); throw error; }
    finally { workspaceKey.fill(0); }
  }
  async function closeWorkspace(userId) {
    const context = contexts.get(userId); if (!context) return;
    if (context.closing) return context.closing;
    context.closing = (async () => {
      // Stop admitting requests before draining work and erasing encryption keys.
      const stopped = context.app.locals.integrations.close();
      if (context.active) await new Promise(accept => context.idle.push(accept));
      await stopped;
      while (context.app.locals.activeJobs.size) await new Promise(accept => setTimeout(accept, 50));
      context.store.close(); context.credentialKey.fill(0); contexts.delete(userId);
    })();
    return context.closing;
  }
  app.post('/api/profiles/:action', async (req, res, next) => {
    if (!['login', 'register'].includes(req.params.action)) return next();
    const attemptId = req.ip, current = attempts.get(attemptId) || { count: 0, until: Date.now() + 15 * 60000 };
    if (current.until < Date.now()) { current.count = 0; current.until = Date.now() + 15 * 60000; }
    if (current.count >= 15 || authenticating >= 4) throw failure('尝试过于频繁，请稍后重试', 429);
    current.count++; attempts.set(attemptId, current);
    const name = typeof req.body?.username === 'string' ? req.body.username.normalize('NFKC').trim().toLowerCase() : '';
    const password = req.body?.password;
    if (!/^[\p{L}\p{N}_-]{2,32}$/u.test(name) || typeof password !== 'string' || password.length < 10 || password.length > 128) throw failure('用户名需为 2–32 位文字、数字或下划线；密码需为 10–128 位');
    authenticating++;
    let key;
    try {
      let user = db.prepare('SELECT * FROM users WHERE name = ?').get(name);
      if (req.params.action === 'register' && user) throw failure('此用户名已存在，请登录或选择其他名称', 409);
      const salt = user?.salt || randomBytes(16);
      key = await derive(password, salt, 600000, 32, 'sha256');
      if (req.params.action === 'login') {
        const verifier = createHmac('sha256', key).update(`login:${user?.id || 'missing'}`).digest();
        if (!user || !timingSafeEqual(verifier, user.verifier)) throw failure('用户名或密码不正确', 401);
      } else {
        user = { id: randomUUID(), name, salt };
        user.verifier = createHmac('sha256', key).update(`login:${user.id}`).digest();
        if (db.prepare('SELECT id FROM users WHERE name = ?').get(name)) throw failure('此用户名已存在', 409);
        db.prepare('INSERT INTO users(id, name, salt, verifier) VALUES (?, ?, ?, ?)').run(user.id, name, salt, user.verifier);
      }
      if (shuttingDown) throw failure('应用正在关闭，请重新打开后登录', 503);
      if (req.body.remember === true) {
        if (!vaultSupported) throw failure('当前环境不支持 Windows 快捷登录，请使用密码登录');
        const payload = Buffer.from(JSON.stringify({ userId: user.id, key: key.toString('base64') }));
        try {
          const protectedKey = await transform('protect', payload);
          db.prepare('INSERT INTO remembered_users(user_id, protected_key, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET protected_key=excluded.protected_key, updated_at=excluded.updated_at').run(user.id, protectedKey, new Date().toISOString());
        } finally { payload.fill(0); }
      }
      openWorkspace(user, key); attempts.delete(attemptId); res.json(makeSession(user));
    } finally { key?.fill(0); authenticating--; }
  });
  app.get('/api/profiles/remembered', (_req, res) => res.json({ supported: vaultSupported, users: vaultSupported ? db.prepare('SELECT users.id, users.name AS username FROM remembered_users JOIN users ON users.id = remembered_users.user_id ORDER BY remembered_users.updated_at DESC').all() : [] }));
  app.delete('/api/profiles/remembered/:id', (req, res) => {
    db.prepare('DELETE FROM remembered_users WHERE user_id = ?').run(req.params.id); res.json({ ok: true });
  });
  app.post('/api/profiles/quick', async (req, res) => {
    if (!vaultSupported) throw failure('当前环境不支持快捷登录');
    if (authenticating >= 4) throw failure('工作区正在解锁，请稍后再试', 429);
    const row = db.prepare('SELECT users.*, remembered_users.protected_key FROM remembered_users JOIN users ON users.id = remembered_users.user_id WHERE users.id = ?').get(typeof req.body?.id === 'string' ? req.body.id : '');
    if (!row) throw failure('此用户未开启快捷登录，请输入密码', 401);
    authenticating++; let key, decrypted;
    try {
      try {
        decrypted = await transform('unprotect', Buffer.from(row.protected_key));
        const saved = JSON.parse(decrypted.toString('utf8'));
        if (saved.userId !== row.id) throw new Error('Invalid identity');
        key = Buffer.from(saved.key, 'base64');
        if (key.length !== 32 || !timingSafeEqual(createHmac('sha256', key).update(`login:${row.id}`).digest(), row.verifier)) throw new Error('Invalid key');
      } catch { throw failure('无法在当前 Windows 账户解锁，请改用密码登录，并重新勾选自动登录', 401); }
      if (shuttingDown) throw failure('应用正在关闭，请重新打开后登录', 503);
      const current = db.prepare('SELECT protected_key FROM remembered_users WHERE user_id = ?').get(row.id);
      if (!current || !Buffer.from(current.protected_key).equals(Buffer.from(row.protected_key))) throw failure('快捷登录设置已更新，请重新选择用户或使用密码登录', 401);
      openWorkspace(row, key); res.json(makeSession(row));
    } finally { decrypted?.fill(0); key?.fill(0); authenticating--; }
  });
  app.get('/api/profiles/session', (req, res) => res.json({ username: identity(req).username }));
  app.post(['/api/profiles/logout', '/api/logout'], async (req, res) => {
    const session = identity(req); sessions.delete(tokenHash(req));
    if (![...sessions.values()].some(s => s.userId === session.userId && s.expiresAt > Date.now())) await closeWorkspace(session.userId);
    res.json({ ok: true });
  });
  // Browser downloads cannot add API headers; tickets are short-lived and only
  // remain valid while the matching workspace is unlocked.
  app.get('/downloads/:ticket', (req, res, next) => {
    const context = [...contexts.values()].find(c => !c.closing && c.app.locals.hasDownload(req.params.ticket));
    if (!context) return res.status(404).send('下载链接已过期，请重新登录后导出。');
    context.app(req, res, next);
  });
  app.use('/api', (req, res, next) => {
    const session = identity(req), context = contexts.get(session.userId);
    if (!context || context.closing) throw failure('工作区已锁定，请重新登录', 401);
    context.active++; let released = false;
    const release = () => { if (released) return; released = true; if (--context.active === 0) for (const accept of context.idle.splice(0)) accept(); };
    res.once('finish', release); res.once('close', release);
    const previousUrl = req.url; req.url = req.originalUrl;
    context.app(req, res, error => { req.url = previousUrl; next(error); });
  });
  app.get('/oauth/douyin/callback', (_req, res) => res.set('Cache-Control', 'no-store').type('html').send('<!doctype html><meta charset="utf-8"><title>返回生长工作台</title><h1>返回工作台完成授权</h1><p>请复制地址栏的完整回调地址，回到工作台的抖音连接中粘贴。</p>'));
  app.use(express.static(staticDirectory, { index: false }));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve(staticDirectory, 'index.html')));
  app.use((error, _req, res, _next) => res.status(error.status || (error.type === 'entity.too.large' ? 413 : 500)).json({ error: error.status ? error.message : '暂时无法打开本地工作区，请重试；原数据已保留。' }));
  const maintenance = setInterval(() => {
    for (const [key, session] of sessions) if (session.expiresAt <= Date.now()) sessions.delete(key);
    for (const id of contexts.keys()) if (![...sessions.values()].some(s => s.userId === id)) closeWorkspace(id).catch(() => {});
  }, 60000); maintenance.unref();
  app.locals.close = async () => { shuttingDown = true; clearInterval(maintenance); sessions.clear(); while (authenticating) await new Promise(accept => setTimeout(accept, 50)); await Promise.all([...contexts.keys()].map(closeWorkspace)); db.close(); };
  return app;
}
