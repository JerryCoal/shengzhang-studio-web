import type { State } from './types';
export const IS_STATIC = import.meta.env.MODE === 'static';
export const IS_WEB = import.meta.env.MODE === 'web';
export const LOCAL_DATA = IS_STATIC || IS_WEB;
export const API_BASE = IS_STATIC ? '' : (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');
export async function api<T>(path: string, method = 'GET', body?: unknown, options?: { keepalive?: boolean }): Promise<T> {
  if (IS_WEB) return (await import('./web-api')).webAPI<T>(path, method, body);
  if (IS_STATIC) return (await import('./local-api')).localAPI<T>(path, method, body);
  const response = await fetch(`${API_BASE}/api${path}`, {
    method, keepalive: !!options?.keepalive && new TextEncoder().encode(JSON.stringify(body) || '').byteLength < 60000, headers: { 'Content-Type': 'application/json', 'X-Studio-Client': 'studio-v1', ...(sessionStorage.getItem('studio-session') ? { Authorization: `Bearer ${sessionStorage.getItem('studio-session')}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({ error: '服务返回了无效数据，请检查服务地址' }));
  if (!response.ok) { if (response.status === 401) window.dispatchEvent(new Event('studio-auth-required')); throw new Error(data.error || '操作失败，请重试'); }
  return data;
}
export type Mutation<T = unknown> = { result: T; state: State };
export function download(data: string | Blob, name: string) {
  const url = typeof data === 'string' ? data : URL.createObjectURL(data);
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  if (typeof data !== 'string') setTimeout(() => URL.revokeObjectURL(url), 10000);
}
export const fileData = (file: Blob): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('文件读取失败')); reader.readAsDataURL(file);
});
