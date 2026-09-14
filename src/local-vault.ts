import type { State } from './types';
import { seedState } from '../server/domain.mjs';
import { normalizeWorkflow } from '../server/workflow.mjs';

type Envelope = { username: string; version: 1; salt: Uint8Array<ArrayBuffer>; iv: Uint8Array<ArrayBuffer>; ciphertext: ArrayBuffer; revision: number };
type Session = { username: string; key: CryptoKey; salt: Uint8Array<ArrayBuffer> };
let session: Session | null = null;
let database: Promise<IDBDatabase> | undefined;
const encoder = new TextEncoder();
const message = '无法保存到当前浏览器。请允许网站存储，或释放设备空间后重试；原数据未被覆盖。';

function db() {
  if (!database) database = new Promise<IDBDatabase>((resolve, reject) => {
    if (!window.isSecureContext || !crypto.subtle || !window.indexedDB) { reject(new Error('请在支持本地存储的浏览器中，通过 HTTPS 打开此网站。')); return; }
    const request = indexedDB.open('shengzhang-local-users-v1', 2);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('users')) request.result.createObjectStore('users', { keyPath: 'username' }); if (!request.result.objectStoreNames.contains('remembered')) request.result.createObjectStore('remembered', { keyPath: 'username' }); };
    request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); database = undefined; }; resolve(request.result); };
    request.onerror = () => reject(new Error(message));
    request.onblocked = () => reject(new Error('请关闭此网站的其他标签页，再重新打开。'));
  }).catch(error => { database = undefined; throw error; });
  return database;
}
const normalize = (username: string) => username.trim().normalize('NFKC').toLocaleLowerCase('en-US');
export function localUsername() { return session?.username || ''; }
export function lockLocalWorkspace() { session = null; window.dispatchEvent(new Event('studio-local-locked')); }
export async function rememberedLocalUsers(): Promise<{ id: string; username: string }[]> {
  const connection = await db();
  return new Promise((resolve, reject) => { const request = connection.transaction('remembered').objectStore('remembered').getAllKeys(); request.onsuccess = () => resolve(request.result.map(value => ({ id: String(value), username: String(value) }))); request.onerror = () => reject(new Error('无法读取此浏览器的快捷登录')); });
}
export async function forgetLocalUser(username: string) {
  const connection = await db();
  await new Promise<void>((resolve, reject) => { const tx = connection.transaction('remembered', 'readwrite'); tx.objectStore('remembered').delete(username); tx.oncomplete = () => resolve(); tx.onabort = () => reject(new Error(message)); });
}
export async function rememberLocalUser() {
  const user = activeSession(), connection = await db();
  // Non-extractable CryptoKey; remembering explicitly allows this browser to unlock without a password.
  await new Promise<void>((resolve, reject) => { const tx = connection.transaction('remembered', 'readwrite'); tx.objectStore('remembered').put(user); tx.oncomplete = () => resolve(); tx.onabort = () => reject(new Error(message)); });
}
export async function quickLoginLocal(username: string) {
  const connection = await db();
  const user = await new Promise<Session | undefined>((resolve, reject) => { const request = connection.transaction('remembered').objectStore('remembered').get(username); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error(message)); });
  const record = await read(username);
  if (!user || !record || user.key.extractable || user.username !== username) throw new Error('快捷登录不可用，请使用密码登录');
  try { await decrypt(record, user); } catch { throw new Error('快捷登录无法解锁，请使用密码登录'); }
  const current = await rememberedLocalUsers();
  if (!current.some(value => value.username === username)) throw new Error('此用户已取消快捷登录');
  session = user; return username;
}
function activeSession() { if (!session) throw new Error('请先登录本地工作区'); return session; }
async function derive(password: string, salt: Uint8Array<ArrayBuffer>) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function read(username: string) {
  const connection = await db();
  return new Promise<Envelope | undefined>((resolve, reject) => {
    const request = connection.transaction('users').objectStore('users').get(username);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error('无法读取当前浏览器中的数据，请稍后重试。'));
  });
}
async function encrypt(state: State, user: Session, revision: number): Promise<Envelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(`shengzhang:v1:${user.username}`) }, user.key, encoder.encode(JSON.stringify(state)));
  return { username: user.username, version: 1, salt: user.salt, iv, ciphertext, revision };
}
async function decrypt(record: Envelope, user: Session): Promise<State> {
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv, additionalData: encoder.encode(`shengzhang:v1:${user.username}`) }, user.key, record.ciphertext);
  const state = JSON.parse(new TextDecoder().decode(plaintext)) as State;
  if (record.version !== 1 || state.schemaVersion !== 1 || !Array.isArray(state.projects) || !Array.isArray(state.accounts)) throw new Error('数据版本不兼容');
  return normalizeWorkflow(state);
}
// Compare the saved revision inside the write transaction: another tab cannot silently overwrite it.
async function save(record: Envelope, expectedRevision: number | null) {
  const connection = await db();
  await new Promise<void>((resolve, reject) => {
    const tx = connection.transaction('users', 'readwrite'); const store = tx.objectStore('users');
    let reason = message;
    const request = store.get(record.username);
    request.onsuccess = () => {
      const previous = request.result as Envelope | undefined;
      if (expectedRevision === null ? !!previous : previous?.revision !== expectedRevision) {
        reason = expectedRevision === null ? '此用户名已在当前浏览器注册，请登录或换一个名称。' : '数据已在另一个标签页更新，请重新打开当前页面后再试。'; tx.abort(); return;
      }
      store.put(record);
    };
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(new Error(reason)); tx.onerror = () => { /* onabort reports the transaction failure */ };
  });
}
export async function registerLocal(username: string, password: string) {
  await db();
  username = normalize(username);
  if (!/^[\p{L}\p{N}_-]{2,32}$/u.test(username)) throw new Error('用户名需为 2–32 个字，可使用中文、字母、数字、下划线或短横线。');
  if (password.length < 10 || password.length > 128) throw new Error('请设置 10–128 位密码。');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const user = { username, salt, key: await derive(password, salt) };
  await save(await encrypt(seedState(), user, 1), null);
  session = user;
  return username;
}
export async function loginLocal(username: string, password: string) {
  const record = await read(normalize(username));
  if (!record) throw new Error('此浏览器中没有这个用户，请先注册。账号不会跨设备同步。');
  const user = { username: record.username, salt: record.salt, key: await derive(password, record.salt) };
  try { await decrypt(record, user); } catch { throw new Error('密码不正确，或本地数据已损坏。原数据已保留。'); }
  session = user;
  return user.username;
}
export async function readLocalState() {
  const user = activeSession(); const record = await read(user.username);
  if (!record) { lockLocalWorkspace(); throw new Error('此用户的本地数据已被清除，请重新注册。'); }
  const state = await decrypt(record, user);
  if (session !== user) throw new Error('工作区已退出，请重新登录');
  return state;
}
let queue: Promise<unknown> = Promise.resolve();
export function changeLocalState<T>(work: (state: State) => T) {
  const user = activeSession();
  const action = queue.then(async () => {
    if (session !== user) throw new Error('工作区已退出，请重新登录');
    const record = await read(user.username);
    if (!record) throw new Error('本地数据已被清除，请重新登录');
    const state = await decrypt(record, user); const result = work(state);
    const next = await encrypt(state, user, record.revision + 1);
    if (session !== user) throw new Error('工作区已退出，请重新登录');
    await save(next, record.revision);
    return { result, state };
  });
  queue = action.catch(() => {});
  return action;
}
