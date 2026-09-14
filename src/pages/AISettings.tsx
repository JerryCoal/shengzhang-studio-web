import { useEffect, useState } from 'react';
import { Check, KeyRound, LockKeyhole, ShieldCheck, Sparkles, Trash2 } from 'lucide-react';
import { useStudio } from '../context';
import { api, IS_WEB } from '../api';
import { Field, Pill } from '../components';
import '../ai-settings.css';

export function AISettings() {
  const { settings, run, refresh, busy, notify } = useStudio();
  const [key, setKey] = useState(''); const [routes, setRoutes] = useState(settings.routes);
  const [deleteOpen, setDeleteOpen] = useState(false);
  useEffect(() => setRoutes(settings.routes), [JSON.stringify(settings.routes)]);
  const credential = settings.credential;
  const changed = JSON.stringify(routes) !== JSON.stringify(settings.routes);
  return <section className="panel ai-settings">
    <div className="section-heading"><div className="row gap-10"><span className="section-icon"><KeyRound size={21}/></span><div><h2>API 与模型</h2><small className="muted">让每一步使用合适的算力</small></div></div><Pill color={settings.openaiConfigured ? 'green' : 'gray'}>{settings.openaiConfigured ? settings.verification ? '连接已检查' : '已配置 · 待检查' : '本地模式'}</Pill></div>
    <div className="ai-settings-columns"><div className="credential-panel">
      <h3><LockKeyhole size={18}/>你的本机密钥</h3>
      <div className="setting-row"><span>服务商</span><b>OpenAI</b></div>
      <div className="setting-row"><span>请求地址</span><small>https://api.openai.com/v1</small></div>
      <p className="muted">{IS_WEB ? "密钥由登录密码加密保存在当前浏览器。调用时临时发送到网站后端及 OpenAI 官方接口，后端不保存；项目备份不包含密钥。" : "密钥只发送到本机服务和 OpenAI 官方接口。不会存入浏览器、项目备份或应用安装包。"}</p>
      {credential.local && credential.supported ? <>
        <div className="vault-status"><ShieldCheck size={20}/><span>{credential.source === 'vault' ? `已加密保存 · 末尾 ${credential.suffix}` : credential.source === 'environment' ? '正在使用旧环境变量密钥' : '尚未保存密钥'}<small>{IS_WEB ? '由当前浏览器的登录密码加密保护' : settings.profileMode ? '由本地登录密码与 Windows 账户共同保护' : '使用 Windows 当前用户账户加密'}</small></span></div>
        {credential.source === 'environment' && <p className="info-box">环境变量密钥不属于保险箱。建议在此重新保存，并自行删除旧 .env 中的密钥；删除保险箱后旧配置仍可能生效。</p>}
        <form autoComplete="off" onSubmit={e => { e.preventDefault(); const submitted = key.trim(); setKey(''); void run(async () => { await api('/settings/credential', 'PUT', { apiKey: submitted }); await refresh(); notify('密钥已在本机加密保存，输入框已清空'); }); }}>
          <Field label={credential.configured ? '替换 API Key' : '填写 API Key'} hint="保存后只显示末尾四位，无法从页面取回完整密钥。">
            <input type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={512} required minLength={19} placeholder="sk-…" value={key} disabled={busy} onChange={e => setKey(e.target.value)}/>
          </Field>
          <button className="button primary full" disabled={busy || !key.trim()}><LockKeyhole size={16}/>{busy ? '处理中…' : '加密保存到本机'}</button>
        </form>
        <div className="row gap-10 wrap credential-actions"><button className="button" disabled={busy || !settings.openaiConfigured} onClick={() => void run(async () => { await api('/settings/credential/check', 'POST'); await refresh(); notify('连接检查完成，未发起付费生成'); })}><Check size={16}/>检查连接</button><button className="text-button muted" disabled={busy || (credential.source !== 'vault' && !credential.problem)} onClick={() => setDeleteOpen(true)}><Trash2 size={15}/>删除本机密钥</button></div>
        {deleteOpen && <div className="info-box delete-key"><p>删除后将无法继续使用这份密钥。已经发出的请求不受影响。</p><button className="button small" disabled={busy} onClick={() => setDeleteOpen(false)}>保留</button><button className="button small" disabled={busy} onClick={() => void run(async () => { await api('/settings/credential', 'DELETE'); await refresh(); setDeleteOpen(false); notify('本机密钥已删除'); })}>确认删除</button></div>}
      </> : <div className="info-box"><ShieldCheck size={19}/><span>{!credential.local ? '请在运行服务的 Windows 电脑上打开 localhost 地址配置个人密钥。手机或远程网页不会把你的密钥提交到另一台服务器。' : '当前系统尚未接入安全保险箱，密钥填写已关闭。此版本支持 Windows 当前账户加密存储。'}</span></div>}
      {credential.problem && <p className="info-box error-box" role="alert">{credential.problem}</p>}
      {settings.verification && <div className="connection-result" role="status"><b>连接检查结果</b>{settings.verification.models.map(m => <div className="row between" key={m.model}><span>{m.model}</span><Pill color={m.available ? 'green' : 'amber'}>{m.available ? '账户可见' : '未在列表中'}</Pill></div>)}<small>{settings.verification.note}</small></div>}
      <a className="text-button green" href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">在 OpenAI 创建 API Key ↗</a>
      <details className="setup-details"><summary>密钥保护的范围</summary>{IS_WEB ? <p>密钥使用 AES-GCM 加密后存入浏览器 IndexedDB，只有当前本地用户登录后可使用。后端为完成请求临时处理密钥与必要的项目数据，不提供账号数据库或项目存储。服务商按其自身条款处理请求。清除浏览器数据会同时删除密钥。请只在信任的设备使用，公共设备不应开启快捷登录。</p> : <><p>加密文件位于这台电脑，绑定保存时的 Windows 账户。独立用户版还需要本地登录密码解锁；重新登录后无需重复填写 API 密钥。请求时会短暂解密到本机服务内存；不要向不可信程序开放此 Windows 账户。</p><p>安卓和 iPhone 的设备密钥存储需要分别接入 Keystore / Keychain；当前移动端尚未提供个人密钥填写。工作区备份不包含密钥，但请勿公开整个 data 文件夹。</p></>}</details>
    </div><div className="model-routing">
      <div className="row between"><h3><Sparkles size={18}/>按任务分配模型</h3><button className="text-button green" disabled={busy || !credential.local} onClick={() => setRoutes(Object.fromEntries(settings.stages.map(s => [s.id, s.model])) as typeof routes)}>恢复推荐</button></div>
      <p className="muted">点击各环节的 AI 按钮才会调用。可分别调整；模型不可用时会提示，不会自动切换。</p>
      {settings.stages.map(stage => <div className="model-route" key={stage.id}><div><b>{stage.label}</b><p>{stage.reason}</p></div><div><label className="sr-only" htmlFor={`model-${stage.id}`}>{stage.label}模型</label><select id={`model-${stage.id}`} disabled={busy || !credential.local} value={routes[stage.id]} onChange={e => setRoutes({ ...routes, [stage.id]: e.target.value })}>{Object.entries(settings.models).map(([id, model]) => <option key={id} value={id}>{model.label}{stage.model === id ? ' · 推荐' : ''}</option>)}</select><small>输入 ${settings.models[routes[stage.id]].inputPrice} / 输出 ${settings.models[routes[stage.id]].outputPrice}</small></div></div>)}
      <p className="model-price-note">单价单位：美元 / 百万 token，核对于 {settings.priceDate}。实际费用以账户账单为准。</p>
      <button className="button primary" disabled={busy || !changed || !credential.local} onClick={() => void run(async () => { await api('/settings/models', 'PUT', routes); await refresh(); notify('模型分工已保存，下次调用即生效'); })}><Check size={16}/>保存模型分工</button>
      <div className="local-workflows"><h3>这些步骤在本地完成</h3><div><b>项目资料与排期</b><span>表单、日历和规则校验，无需模型</span></div><div><b>图文封面</b><span>真实产品图 + 本地排版，保持产品外观</span></div><div><b>本地短片</b><span>模板合成 + 上传音频，无需模型</span></div><div><b>数据整理</b><span>排期、评论去重与规则分类</span></div><p>AI 视频使用 GPT Image 2 生成首尾关键帧，再调用 Seedance。视频与平台授权在下方独立配置。</p></div>
    </div></div>
  </section>;
}
