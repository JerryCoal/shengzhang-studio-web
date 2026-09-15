import { useEffect, useState } from 'react';
import { Check, KeyRound, LockKeyhole, ShieldCheck, Sparkles, Trash2 } from 'lucide-react';
import { useStudio } from '../context';
import { api, download, IS_WEB } from '../api';
import { Field, Pill } from '../components';
import '../ai-settings.css';
import type { TextProvider } from '../types';
import { providerLabel, stageProvider } from '../model-provider';

export function AISettings() {
  const { settings, run, refresh, busy, notify } = useStudio();
  const [key, setKey] = useState(''); const [routes, setRoutes] = useState(settings.routes);
  const [deleteOpen, setDeleteOpen] = useState(false);
  useEffect(() => setRoutes(settings.routes), [JSON.stringify(settings.routes)]);
  const [provider, setProvider] = useState<TextProvider>(() => stageProvider(settings, 'strategy'));
  useEffect(() => { setKey(''); setDeleteOpen(false); }, [provider]);
  const service = providerLabel(provider);
  const connection = settings.providers?.[provider];
  const credential = connection?.credential || settings.credential;
  const configured = connection?.configured ?? (provider === 'openai' && settings.openaiConfigured);
  const verification = connection?.verification ?? (provider === 'openai' ? settings.verification : null);
  const diagnostic = connection?.apiDiagnostic ?? (provider === 'openai' ? settings.apiDiagnostic : null);
  const credentialPath = provider === 'openai' ? '/settings/credential' : '/settings/providers/deepseek/credential';
  const changed = JSON.stringify(routes) !== JSON.stringify(settings.routes);
  return <section className="panel ai-settings">
    <div className="section-heading"><div className="row gap-10"><span className="section-icon"><KeyRound size={21}/></span><div><h2>API 与模型</h2><small className="muted">让每一步使用合适的算力</small></div></div><Pill color={diagnostic ? 'amber' : configured ? 'green' : 'gray'}>{diagnostic ? '有请求异常 · 查看诊断' : configured ? verification ? (verification.balance ? (verification.balance.available ? '连接已检查 · 余额可用' : '连接已检查 · 余额不足') : '密钥已验证 · 额度未验证') : '已配置 · 待检查' : '本地模式'}</Pill></div>
    <div className="ai-settings-columns"><div className="credential-panel">
      <h3><LockKeyhole size={18}/>你的本机密钥</h3>
      <Field label="模型服务商" hint="各家密钥独立保存。下方模型分工决定文字任务实际使用的服务商。"><select value={provider} disabled={busy} onChange={e => setProvider(e.target.value as TextProvider)}><option value="openai">OpenAI 官方 API</option><option value="deepseek">DeepSeek 官方 API</option></select></Field>
      <div className="setting-row"><span>请求地址</span><small>{provider === 'openai' ? 'https://api.openai.com/v1' : 'https://api.deepseek.com'}</small></div>
      <p className="muted">{IS_WEB ? `密钥由登录密码加密保存在当前浏览器。调用时临时发送到网站后端及 ${service} 官方接口，后端不保存；项目备份不包含密钥。` : `密钥只发送到本机服务和 ${service} 官方接口。不会存入浏览器、项目备份或应用安装包。`}</p>
      {credential.local && credential.supported ? <>
        <div className="vault-status"><ShieldCheck size={20}/><span>{credential.source === 'vault' ? `已加密保存 · 末尾 ${credential.suffix}` : credential.source === 'environment' ? '正在使用旧环境变量密钥' : '尚未保存密钥'}<small>{IS_WEB ? '由当前浏览器的登录密码加密保护' : settings.profileMode ? '由本地登录密码与 Windows 账户共同保护' : '使用 Windows 当前用户账户加密'}</small></span></div>
        {credential.source === 'environment' && <p className="info-box">环境变量密钥不属于保险箱。建议在此重新保存，并自行删除旧 .env 中的密钥；删除保险箱后旧配置仍可能生效。</p>}
        <form autoComplete="off" onSubmit={e => { e.preventDefault(); const submitted = key.trim(); setKey(''); void run(async () => { await api(credentialPath, 'PUT', { apiKey: submitted }); await refresh(); notify('密钥已在本机加密保存，输入框已清空'); }); }}>
          <Field label={credential.configured ? '替换 API Key' : '填写 API Key'} hint="保存后只显示末尾四位，无法从页面取回完整密钥。">
            <input type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={512} required minLength={19} placeholder="sk-…" value={key} disabled={busy} onChange={e => setKey(e.target.value)}/>
          </Field>
          <button className="button primary full" disabled={busy || !key.trim()}><LockKeyhole size={16}/>{busy ? '处理中…' : '加密保存到本机'}</button>
        </form>
        <div className="row gap-10 wrap credential-actions"><button className="button" disabled={busy || !configured} onClick={() => void run(async () => { await api(`${credentialPath}/check`, 'POST'); await refresh(); notify('连接检查完成，未发起付费生成'); })}><Check size={16}/>{provider === 'deepseek' ? '检查连接与余额' : '检查连接'}</button><button className="text-button muted" disabled={busy || (credential.source !== 'vault' && !credential.problem)} onClick={() => setDeleteOpen(true)}><Trash2 size={15}/>删除本机密钥</button></div>
        {deleteOpen && <div className="info-box delete-key"><p>删除后将无法继续使用这份密钥。已经发出的请求不受影响。</p><button className="button small" disabled={busy} onClick={() => setDeleteOpen(false)}>保留</button><button className="button small" disabled={busy} onClick={() => void run(async () => { await api(credentialPath, 'DELETE'); await refresh(); setDeleteOpen(false); notify('本机密钥已删除'); })}>确认删除</button></div>}
      </> : <div className="info-box"><ShieldCheck size={19}/><span>{!credential.local ? '请在运行服务的 Windows 电脑上打开 localhost 地址配置个人密钥。手机或远程网页不会把你的密钥提交到另一台服务器。' : '当前系统尚未接入安全保险箱，密钥填写已关闭。此版本支持 Windows 当前账户加密存储。'}</span></div>}
      {credential.problem && <p className="info-box error-box" role="alert">{credential.problem}</p>}
      {diagnostic && <div className="api-diagnostic" role="alert">
        <b>最近一次 API 异常</b><p>{diagnostic.message}</p>
        <small>{new Date(diagnostic.at).toLocaleString()} · {diagnostic.model || (diagnostic.endpoint === 'models' ? '检查连接' : service)} · {diagnostic.code}{diagnostic.upstreamStatus ? ` · HTTP ${diagnostic.upstreamStatus}` : ''}</small>
        {diagnostic.retryAt && <p>建议重试时间：{new Date(diagnostic.retryAt).toLocaleString()}。等待期间再次点击不会发送同模型的生成请求。</p>}
        <button className="text-button" onClick={() => download(new Blob([JSON.stringify({ version: settings.version, ...diagnostic }, null, 2)], { type: 'application/json' }), `${service}-诊断结果.json`)}>导出诊断结果（不含密钥和项目资料）</button>
      </div>}
      {verification && <div className="connection-result" role="status"><b>连接检查结果</b>{verification.models.map(m => <div className="row between" key={m.model}><span>{m.model}</span><Pill color={m.available ? 'green' : 'amber'}>{m.available ? '账户可见' : '未在列表中'}</Pill></div>)}{verification.balance && <div className="balance-result"><b>{verification.balance.available ? 'DeepSeek 余额可用' : 'DeepSeek 当前余额不足'}</b>{verification.balance.items.map((b, i) => <p key={i}>{b.currency} {b.total}</p>)}<small>查询时间：{new Date(verification.checkedAt).toLocaleString()}；余额可能随调用变化。</small></div>}<small>{verification.note}</small></div>}
      <a className="text-button green" href={provider === 'openai' ? 'https://platform.openai.com/api-keys' : 'https://platform.deepseek.com/api_keys'} target="_blank" rel="noreferrer">在 {service} 创建 API Key ↗</a>
      {provider === 'openai' ? (<div className="api-help"><b>密钥能保存，为什么还不能生成？</b><p>创建密钥不等于获得 API 额度。“检查连接”只读取模型列表，不进行付费生成，也无法查询账户余额。应用里的项目预算只是费用提醒，不会向 OpenAI 充值。</p><div className="row gap-10 wrap"><a href="https://platform.openai.com/settings/organization/billing/overview" target="_blank" rel="noreferrer">检查 Billing 余额 ↗</a><a href="https://platform.openai.com/settings/organization/limits" target="_blank" rel="noreferrer">查看 Limits 上限 ↗</a><a href="https://platform.openai.com/settings/organization/projects" target="_blank" rel="noreferrer">检查项目与权限 ↗</a></div><p>先处理诊断提示，再回到原来的生成步骤重试。模型列表可见仍不代表拥有该模型的生成权限。</p></div>) : <div className="api-help"><b>DeepSeek 连接说明</b><p>填写 DeepSeek 官方密钥后，点击“检查连接与余额”。这里读取官方模型列表与余额，不发起付费生成；余额可用不保证每次生成一定成功。</p><p>Flash 适合日常文案、分类和复盘，V4 Pro 适合策略与下期策划。策划和复盘启用思考模式，文案与分类关闭思考以节省费用。关键帧仍需 OpenAI 密钥，视频仍需 Seedance。</p><a href="https://platform.deepseek.com" target="_blank" rel="noreferrer">打开 DeepSeek 控制台 ↗</a></div>}
      <details className="setup-details"><summary>密钥保护的范围</summary>{IS_WEB ? <p>密钥使用 AES-GCM 加密后存入浏览器 IndexedDB，只有当前本地用户登录后可使用。后端为完成请求临时处理密钥与必要的项目数据，不提供账号数据库或项目存储。服务商按其自身条款处理请求。清除浏览器数据会同时删除密钥。请只在信任的设备使用，公共设备不应开启快捷登录。</p> : <><p>加密文件位于这台电脑，绑定保存时的 Windows 账户。独立用户版还需要本地登录密码解锁；重新登录后无需重复填写 API 密钥。请求时会短暂解密到本机服务内存；不要向不可信程序开放此 Windows 账户。</p><p>安卓和 iPhone 的设备密钥存储需要分别接入 Keystore / Keychain；当前移动端尚未提供个人密钥填写。工作区备份不包含密钥，但请勿公开整个 data 文件夹。</p></>}</details>
    </div><div className="model-routing">
      <div className="row between"><h3><Sparkles size={18}/>按任务分配模型</h3><button className="text-button green" disabled={busy || !credential.local} onClick={() => setRoutes(Object.fromEntries(settings.stages.map(s => [s.id, s.model])) as typeof routes)}>恢复 OpenAI 分工</button></div>
      <p className="muted">点击各环节的 AI 按钮才会调用。可分别调整；模型不可用时会提示，不会自动切换。</p>
      <button className="button small" disabled={busy || !credential.local} onClick={() => setRoutes(Object.fromEntries(settings.stages.map(s => [s.id, ['strategy', 'planning'].includes(s.id) ? 'deepseek-v4-pro' : 'deepseek-flash'])) as typeof routes)}>文字任务使用 DeepSeek 分工</button><p className="muted">调整后点击“保存模型分工”生效。也可逐项混用两家服务商；不会自动换到其他服务商。</p>
      {settings.stages.map(stage => <div className="model-route" key={stage.id}><div><b>{stage.label}</b><p>{stage.reason}</p></div><div><label className="sr-only" htmlFor={`model-${stage.id}`}>{stage.label}模型</label><select id={`model-${stage.id}`} disabled={busy || !credential.local} value={routes[stage.id]} onChange={e => setRoutes({ ...routes, [stage.id]: e.target.value })}>{(['openai', 'deepseek'] as const).map(p => <optgroup key={p} label={providerLabel(p)}>{Object.entries(settings.models).filter(([, m]) => (m.provider || 'openai') === p).map(([id, model]) => <option key={id} value={id}>{model.label}{stage.model === id ? ' · 推荐' : ''}</option>)}</optgroup>)}</select><small>输入 ${settings.models[routes[stage.id]].inputPrice} / 输出 ${settings.models[routes[stage.id]].outputPrice}</small></div></div>)}
      <p className="model-price-note">单价单位：美元 / 百万 token，核对于 {settings.priceDate}。DeepSeek 按高峰、缓存未命中单价估算，实际可能更低。费用以账户账单为准。</p>
      <button className="button primary" disabled={busy || !changed || !credential.local} onClick={() => void run(async () => { await api('/settings/models', 'PUT', routes); await refresh(); notify('模型分工已保存，下次调用即生效'); })}><Check size={16}/>保存模型分工</button>
      <div className="local-workflows"><h3>这些步骤在本地完成</h3><div><b>项目资料与排期</b><span>表单、日历和规则校验，无需模型</span></div><div><b>图文封面</b><span>真实产品图 + 本地排版，保持产品外观</span></div><div><b>本地短片</b><span>模板合成 + 上传音频，无需模型</span></div><div><b>数据整理</b><span>排期、评论去重与规则分类</span></div><p>AI 视频使用 GPT Image 2 生成首尾关键帧，再调用 Seedance。视频与平台授权在下方独立配置。</p></div>
    </div></div>
  </section>;
}
