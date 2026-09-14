import { lookup } from 'node:dns/promises';
import { assert } from './domain.mjs';

export const integrationError = (message, status = 502, extra = {}) => Object.assign(new Error(message), { status, ...extra });
export async function requestJSON(url, init, fetcher = fetch, label = '服务商', limit = 2_000_000) {
  let response;
  try {
    response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(init.timeout || 180000) });
    if (!response.ok) throw integrationError(`${label}请求被拒绝（HTTP ${response.status}），请检查权限、余额或稍后重试。`, 502, { noCharge: response.status >= 400 && response.status < 500 });
    const bytes = await readBounded(response, limit);
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (error.status) throw error;
    throw integrationError(`${label}未返回可用结果。请核对控制台任务记录；系统不会自动重复提交。`);
  }
}
export async function readBounded(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw integrationError('返回的文件超过本机允许的大小'); }
  const chunks = []; let length = 0;
  for await (const chunk of response.body || []) { length += chunk.length; if (length > limit) throw integrationError('返回的文件超过本机允许的大小'); chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks);
}
// Generated media is downloaded without API credentials. Only public HTTPS CDN addresses are accepted.
export function isPublicAddress(address) {
  if (address.includes(':')) return /^(2|3)[0-9a-f]{3}:/i.test(address);
  const p = address.split('.').map(Number);
  return p.length === 4 && p.every(n => Number.isInteger(n) && n >= 0 && n <= 255) && ![0, 10, 127].includes(p[0]) && p[0] < 224 && !(p[0] === 169 && p[1] === 254) && !(p[0] === 172 && p[1] >= 16 && p[1] <= 31) && !(p[0] === 192 && [0, 168].includes(p[1])) && !(p[0] === 100 && p[1] >= 64 && p[1] <= 127) && !(p[0] === 198 && [18, 19, 51].includes(p[1])) && !(p[0] === 203 && p[1] === 0);
}
export async function downloadVideo(url, fetcher = fetch, resolver = lookup) {
  let target; try { target = new URL(url); } catch { throw integrationError('视频下载地址无效'); }
  assert(target.protocol === 'https:' && !target.username && !target.password && (!target.port || target.port === '443'), '视频下载地址不符合要求', 502);
  // Restrict to ByteDance-owned output CDNs as well as validating DNS; no user-defined URLs.
  assert(['bytepluses.com', 'byteplus.com', 'volces.com', 'volccdn.com', 'volcengineapi.com', 'ibytedtos.com', 'bytedance.net'].some(host => target.hostname.endsWith('.' + host)), '视频返回了未支持的下载域名，请在服务商控制台下载；不会访问该地址。', 502);
  const addresses = await resolver(target.hostname, { all: true });
  assert(addresses.length && addresses.every(item => isPublicAddress(item.address)), '视频下载地址不可用', 502);
  let response; try { response = await fetcher(target.href, { redirect: 'error', signal: AbortSignal.timeout(120000) }); } catch { throw integrationError('视频已生成，但下载未完成；可再次查询以重新下载。'); }
  assert(response.ok, '视频下载未完成，请再次查询', 502);
  const bytes = await readBounded(response, 17_900_000);
  assert(bytes.subarray(4, 8).toString() === 'ftyp', '服务商返回的文件不是有效 MP4', 502);
  return `data:video/mp4;base64,${bytes.toString('base64')}`;
}
