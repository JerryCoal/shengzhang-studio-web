import { z } from 'zod';
import { readBounded } from './integration-http.mjs';
import { assert } from './domain.mjs';

const HOST = 'https://api.deepseek.com';
const models = ['deepseek-flash', 'deepseek-v4-pro'];
export const deepseekUsage = usage => usage && Number.isInteger(usage.prompt_tokens) && usage.prompt_tokens >= 0 && Number.isInteger(usage.completion_tokens) && usage.completion_tokens >= 0 ? { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens } : null;
function providerError(status, context, retryAfter = 60) {
  const [kind, code, message] = ({
    401: ['authentication', 'invalid_api_key', 'DeepSeek 密钥验证失败。请使用 DeepSeek 官方平台创建的密钥，检查是否已删除或失效。'],
    402: ['billing', 'insufficient_balance', 'DeepSeek API 余额不足。请到 DeepSeek 控制台检查余额；创建新密钥不会增加余额。'],
    403: ['permission', 'permission_denied', 'DeepSeek 拒绝访问。请核对该账户及模型的访问权限。'],
    404: ['permission', 'model_not_found', 'DeepSeek 未找到此模型或接口。请检查连接结果，并选择账户可见的模型。'],
    429: ['rate_limit', 'rate_limit_exceeded', `DeepSeek 请求频率受限，请至少等待 ${retryAfter} 秒后再试。`],
    400: ['request', 'invalid_request', 'DeepSeek 未接受本次请求格式，请核对模型与功能，或更新应用。'],
    422: ['request', 'invalid_parameters', 'DeepSeek 未接受本次请求参数，请核对模型与功能，或更新应用。'],
  })[status] || ['service', `http_${status}`, `DeepSeek 服务暂时未完成请求（HTTP ${status}）。请核对服务状态及账单后再试，未自动重复提交。`];
  const at = new Date().toISOString();
  return Object.assign(new Error(message), { status: 502, noCharge: status >= 400 && status < 500 && status !== 408,
    diagnostic: { provider: 'deepseek', kind, code, upstreamStatus: status, message, at, ...context, ...(status === 429 ? { retryAfterSeconds: retryAfter, retryAt: new Date(Date.now() + retryAfter * 1000).toISOString() } : {}) } });
}
export function createDeepSeekTransport(fetcher = fetch) {
  let last = null; const cooldowns = new Map();
  return {
    diagnostic: () => last ? structuredClone(last) : null,
    reset() { last = null; cooldowns.clear(); },
    async fetch(url, init = {}) {
      if (new URL(url).origin !== HOST) return fetcher(url, init);
      const endpoint = new URL(url).pathname === '/chat/completions' ? 'responses' : 'models';
      let model; try { const value = JSON.parse(init.body || '{}').model; if (models.includes(value)) model = value; } catch { /* Diagnostic metadata never includes request content. */ }
      const context = { endpoint, ...(model ? { model } : {}) }, scope = `${endpoint}:${model || ''}`, limited = cooldowns.get(scope);
      if (limited && Date.parse(limited.retryAt) > Date.now()) throw Object.assign(new Error(`DeepSeek 仍在限流等待期，请 ${Math.ceil((Date.parse(limited.retryAt) - Date.now()) / 1000)} 秒后再试。本次未发送新请求。`), { status: 429, noCharge: true, diagnostic: limited });
      cooldowns.delete(scope);
      try {
        const response = await fetcher(url, init);
        if (!response.ok) {
          const header = response.headers.get('retry-after');
          const wait = header && /^\d+(\.\d+)?$/.test(header.trim()) ? Number(header) : (Date.parse(header || '') - Date.now()) / 1000;
          // Never copy the error body: providers can echo keys and project content.
          await response.body?.cancel().catch(() => {});
          throw providerError(response.status, context, Number.isFinite(wait) && wait >= 0 && wait < 315360000 ? Math.max(1, Math.ceil(wait)) : 60);
        }
        if (last?.endpoint === endpoint && last?.model === model) last = null;
        return response;
      } catch (error) {
        const message = '未能完成与 DeepSeek 的连接，请检查网络。若请求已发出，请核对 DeepSeek 账单后再试，避免重复生成。';
        const safe = error.diagnostic ? error : Object.assign(new Error(message), { status: 502, diagnostic: { provider: 'deepseek', kind: 'network', code: 'connection_failed', message, at: new Date().toISOString(), ...context } });
        last = safe.diagnostic; if (last.kind === 'rate_limit') cooldowns.set(scope, last); throw safe;
      }
    },
  };
}
async function request(path, key, body, fetcher = fetch) {
  const transport = createDeepSeekTransport(fetcher);
  const response = await transport.fetch(HOST + path, { method: body ? 'POST' : 'GET', redirect: 'error', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(180000), ...(body ? { body: JSON.stringify(body) } : {}) });
  try { return JSON.parse((await readBounded(response, 2_000_000)).toString('utf8')); }
  catch { throw Object.assign(new Error('DeepSeek 返回结果无法读取。请核对账单，现有内容已保留。'), { status: 502 }); }
}
export async function verifyDeepSeek(key, fetcher) {
  const data = await request('/models', key, undefined, fetcher);
  assert(Array.isArray(data.data), 'DeepSeek 模型列表响应无效', 502);
  const visible = new Set(data.data.map(m => m.id));
  const balance = z.object({ is_available: z.boolean(), balance_infos: z.array(z.object({ currency: z.enum(['CNY', 'USD']), total_balance: z.string().regex(/^-?\d{1,15}(\.\d{1,12})?$/) })).max(5) }).safeParse(await request('/user/balance', key, undefined, fetcher));
  assert(balance.success, 'DeepSeek 余额响应无效，请到官方控制台核对', 502);
  return { checkedAt: new Date().toISOString(), models: models.map(model => ({ model, available: visible.has(model) })), balance: { available: balance.data.is_available, items: balance.data.balance_infos.map(b => ({ currency: b.currency, total: b.total_balance })) },
    note: '已读取 DeepSeek 官方模型列表与余额快照，未发起付费生成。余额与权限仍以实际调用时为准。' };
}
function schemaExample(schema) {
  if (schema.type === 'object') return Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, schemaExample(v)]));
  if (schema.type === 'array') return [schemaExample(schema.items)];
  return schema.enum?.[0] || '根据输入填写';
}
export function deepseekInstructions(instructions, definition) {
  return `${instructions}\n仅输出 json 对象。字段与约束：${JSON.stringify(definition.schema)}\n格式示例（只参考结构，不抄示例内容）：${JSON.stringify(schemaExample(definition.schema))}`;
}
export async function generateDeepSeek(payload, config, definition, instructions, fetcher) {
  const result = await request('/chat/completions', config.apiKey, { model: config.model, stream: false, max_tokens: config.maxTokens,
    thinking: { type: config.thinking ? 'enabled' : 'disabled' }, ...(config.thinking ? { reasoning_effort: config.effort === 'low' ? 'low' : 'high' } : {}),
    response_format: { type: 'json_object' }, messages: [{ role: 'system', content: deepseekInstructions(instructions, definition) }, { role: 'user', content: JSON.stringify(payload) }],
  }, fetcher);
  const usage = deepseekUsage(result.usage);
  try {
    const choice = result.choices?.[0]; assert(choice?.finish_reason === 'stop' && typeof choice.message?.content === 'string', 'DeepSeek 未完成', 502);
    return { value: definition.validate(JSON.parse(choice.message.content), payload), usage };
  } catch { throw Object.assign(new Error('DeepSeek 结果不完整或引用不符合要求。现有内容已保留；费用按返回用量或预留金额记录。'), { status: 502, usage }); }
}
