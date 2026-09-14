// Only our own messages and known provider codes leave this module. Provider error
// bodies can echo credentials, prompts or personal data and must never be logged.
const details = {
  credit_balance_exhausted: ['billing', 'OpenAI API 预付余额已用完。请到 OpenAI 的 Billing 页面检查并补充余额；重新创建密钥不会增加额度。'],
  organization_spend_limit_exceeded: ['billing', 'OpenAI 组织的 API 支出上限已用完。请让组织管理员检查 Limits 中的支出设置，或等待额度重置。'],
  project_spend_limit_exceeded: ['billing', '此密钥所属的 OpenAI 项目已达到 API 支出上限。请检查该项目的 Limits 设置，或等待额度重置。'],
  organization_usage_limit_exceeded: ['billing', 'OpenAI 组织已达到服务商批准的 API 用量上限。请在 Limits 中申请提高上限，或等待额度重置。'],
  insufficient_quota: ['billing', 'OpenAI API 可用额度不足。请检查此密钥所属组织的 Billing 余额与 Limits 用量上限。重新创建密钥或反复重试不会补充额度。'],
  billing_hard_limit_reached: ['billing', 'OpenAI API 账户已达到计费上限。请检查 Billing 与 Limits，处理后再生成。'],
  billing_not_active: ['billing', 'OpenAI API 计费尚未启用。请在 Billing 中检查此密钥所属组织的计费状态。'],
  rate_limit_exceeded: ['rate_limit', 'OpenAI 请求或 token 频率达到上限。'],
  slow_down: ['rate_limit', 'OpenAI 要求降低请求速度。'],
  invalid_api_key: ['authentication', 'OpenAI 未接受这份密钥，可能已失效或被撤销。请在官方平台核对后，到设置页替换。'],
  model_not_found: ['permission', '当前 OpenAI 项目无法使用所选模型。请核对该项目的模型权限，或在设置中选择有权限的模型。'],
  permission_denied: ['permission', 'OpenAI 拒绝了此密钥的接口权限。请检查项目成员资格、密钥的接口权限和模型权限。'],
  unsupported_country_region_territory: ['region', 'OpenAI 返回地区不受支持。请核对实际请求所在地区是否在官方支持范围内。'],
  server_is_overloaded: ['service', 'OpenAI 模型服务暂时繁忙。请稍后重试；本次未自动重复提交。'],
};
const safeModels = new Set(['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-image-2']);
function requestContext(url, init) {
  let target;
  try { target = new URL(url); } catch { return null; }
  if (target.origin !== 'https://api.openai.com' || !target.pathname.startsWith('/v1/')) return null;
  const endpoint = target.pathname === '/v1/models' ? 'models' : target.pathname === '/v1/responses' ? 'responses' : target.pathname.startsWith('/v1/images/') ? 'images' : 'other';
  let model;
  try { model = typeof init.body === 'string' ? JSON.parse(init.body).model : init.body?.get?.('model'); } catch { /* Never copy untrusted request data into diagnostics. */ }
  return { endpoint, ...(safeModels.has(model) ? { model } : {}) };
}
async function errorBody(response) {
  try {
    const chunks = []; let size = 0;
    for await (const chunk of response.body || []) {
      size += chunk.length;
      if (size > 65536) return null;
      chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))?.error;
  } catch { return null; }
}
function retrySeconds(response, clock) {
  const value = response.headers.get('retry-after');
  if (!value || value.length > 100) return 60;
  const seconds = /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : (Date.parse(value) - clock) / 1000;
  // Ignore invalid/unrepresentable delays rather than shortening a valid server delay.
  return Number.isFinite(seconds) && seconds >= 0 && seconds <= 315360000 ? Math.max(1, Math.ceil(seconds)) : 60;
}
export async function openAIResponseError(response, context = {}, clock = Date.now()) {
  const body = await errorBody(response), status = response.status;
  let code = typeof body?.code === 'string' && Object.hasOwn(details, body.code) ? body.code : '';
  if (!code && body?.type === 'insufficient_quota') code = 'insufficient_quota';
  if (!code && status === 429 && ['rate_limit_error', 'rate_limit_exceeded'].includes(body?.type)) code = 'rate_limit_exceeded';
  let [kind, message] = details[code] || (status === 401 ? ['authentication', 'OpenAI 身份验证未通过。请核对密钥、组织成员资格及项目的 IP 访问设置。'] :
    status === 403 || status === 404 ? ['permission', 'OpenAI 拒绝访问此接口或模型。请检查密钥权限、项目模型权限和官方支持地区。'] :
    status === 429 ? ['unknown_limit', 'OpenAI 返回 HTTP 429，但未提供可识别的原因。请先检查 Billing 余额和 Limits；暂时无法确定是额度不足还是请求过快。'] :
    status === 400 || status === 422 ? ['request', 'OpenAI 未接受本次请求参数。请检查所选模型是否支持此功能，并更新应用；不应仅通过重新创建密钥处理。'] :
    ['service', `OpenAI 服务返回 HTTP ${status}。本次未自动重复提交，请核对服务状态与账单后再试。`]);
  const retryAfterSeconds = kind === 'rate_limit' ? retrySeconds(response, clock) : undefined;
  if (retryAfterSeconds) message += ` 请至少等待 ${retryAfterSeconds} 秒后再试；若持续出现，请查看 Limits 并减少单次内容或并发任务。`;
  const diagnostic = { provider: 'openai', kind, code: code || `http_${status}`, upstreamStatus: status, message, at: new Date(clock).toISOString(), ...context,
    ...(retryAfterSeconds ? { retryAfterSeconds, retryAt: new Date(clock + retryAfterSeconds * 1000).toISOString() } : {}) };
  return Object.assign(new Error(message), { status: 502, noCharge: status >= 400 && status < 500 && status !== 408, diagnostic });
}
export function openAINetworkError(context = {}) {
  const message = '未能完成与 OpenAI 的连接。请检查网络及系统代理；Windows 应用在启动时读取代理设置，网络配置改变后请从托盘退出并重新打开。若请求已发出，请先核对账单，避免重复生成。';
  return Object.assign(new Error(message), { status: 502, diagnostic: { provider: 'openai', kind: 'network', code: 'connection_failed', message, at: new Date().toISOString(), ...context } });
}
export function createOpenAITransport(fetcher = fetch, clock = Date.now) {
  let last = null;
  const cooldowns = new Map();
  return {
    diagnostic: () => last ? structuredClone(last) : null,
    reset() { last = null; cooldowns.clear(); },
    async fetch(url, init = {}) {
      const context = requestContext(url, init);
      if (!context) return fetcher(url, init);
      const scope = `${context.endpoint}:${context.model || ''}`, blocked = cooldowns.get(scope);
      if (blocked && Date.parse(blocked.retryAt) > clock()) {
        const seconds = Math.ceil((Date.parse(blocked.retryAt) - clock()) / 1000);
        throw Object.assign(new Error(`OpenAI 仍在限流等待期，请 ${seconds} 秒后再试。本次未发送新请求。`), { status: 429, noCharge: true, diagnostic: blocked });
      }
      cooldowns.delete(scope);
      try {
        const response = await fetcher(url, init);
        if (!response.ok) throw await openAIResponseError(response, context, clock());
        // Reading the model list does not demonstrate that generation quota is available.
        if (last?.endpoint === context.endpoint && last?.model === context.model) last = null;
        return response;
      } catch (error) {
        const safe = error.diagnostic ? error : openAINetworkError(context);
        last = safe.diagnostic;
        if (last.kind === 'rate_limit') cooldowns.set(scope, last);
        throw safe;
      }
    },
  };
}
