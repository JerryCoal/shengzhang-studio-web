import { useEffect, useState } from 'react';
import { KeyRound, Link2, LockKeyhole, RefreshCw, Video } from 'lucide-react';
import { api, IS_WEB } from '../api';
import { useStudio } from '../context';
import { Field, Pill } from '../components';
import type { Integrations } from '../types';
import '../integrations.css';

export function useIntegrations() {
  const [value, setValue] = useState<Integrations | null>(null), [error, setError] = useState('');
  const reload = async () => { try { setValue(await api<Integrations>('/integrations')); setError(''); } catch (e) { setError(e instanceof Error ? e.message : '无法读取连接设置'); } };
  useEffect(() => { void reload(); }, []);
  return { value, error, reload };
}
export function IntegrationSettings() {
  const { value, error, reload } = useIntegrations();
  const { run, busy, refresh, notify, state } = useStudio();
  const [seedKey, setSeedKey] = useState(''), [region, setRegion] = useState<'volcengine' | 'byteplus'>('volcengine'), [model, setModel] = useState('');
  const [reservation, setReservation] = useState(2), [price, setPrice] = useState(0), [clientKey, setClientKey] = useState(''), [clientSecret, setClientSecret] = useState(''), [redirect, setRedirect] = useState(`${location.origin}/oauth/douyin/callback`);
  const [authorizeUrl, setAuthorizeUrl] = useState(''), [callback, setCallback] = useState(''), [deleteService, setDeleteService] = useState('');
  useEffect(() => { if (value) { setRegion(value.seedance.region); setModel(value.seedance.model); setReservation(value.seedance.reservationUsd); setPrice(value.seedance.outputPriceUsd); if (value.douyin.redirectUri) setRedirect(value.douyin.redirectUri); } }, [value]);
  const changed = async () => { await reload(); await refresh(); };
  if (error) return <div className="info-box"><span>{error}</span><button className="button small" onClick={() => void reload()}>重新加载连接</button></div>;
  if (!value) return <p className="muted">正在读取生成与发布连接…</p>;
  const editable = value.local;
  return <section className="panel integration-settings">
    <div className="section-heading"><div><h2>生成与平台连接</h2><p className="muted">关键帧 → 视频 → 发布 → 评论，按需要启用。</p></div><button className="button small" disabled={busy} onClick={() => void run(changed)}><RefreshCw size={15}/>刷新状态</button></div>
    <div className="info-box">{IS_WEB ? "网页版需保持原工作区页面打开并联网，才能按时投稿和同步评论。浏览器休眠、关闭或退出登录时会暂停；重新打开后继续查询已保存的任务。" : "自动任务需要保持应用和本地服务运行。"}</div><div className="service-grid">
      <article className="service-card"><div className="service-title"><Video size={21}/><h3>Seedance 视频生成</h3><Pill color={value.seedance.configured ? 'green' : 'gray'}>{value.seedance.configured ? '密钥已保存 · 待实测' : '待配置'}</Pill></div>
        <p>先使用 OpenAI 的 <b>GPT Image 2</b> 生成首尾关键帧，再由 Seedance 生成短片。关键帧复用上方的 OpenAI 密钥。</p>
        <form autoComplete="off" onSubmit={e => { e.preventDefault(); const submitted = seedKey; setSeedKey(''); void run(async () => { await api('/integrations/seedance', 'PUT', { region, model, reservationUsd: reservation, outputPriceUsd: price, ...(submitted.trim() ? { apiKey: submitted.trim() } : {}) }); await changed(); notify('Seedance 配置已保存；可到内容制作检查并生成关键帧'); }); }}>
          <Field label="Seedance 服务区域" hint="密钥、模型与服务区域必须来自同一控制台。"><select disabled={!editable || busy} value={region} onChange={e => setRegion(e.target.value as typeof region)}><option value="volcengine">火山方舟 · 中国北京</option><option value="byteplus">BytePlus ModelArk · 新加坡</option></select></Field>
          <Field label="Seedance 模型 / 接入点 ID" hint="从控制台复制已开通的 Seedance 模型或 ep- 接入点，选择支持首尾帧的型号。"><input required value={model} maxLength={120} spellCheck={false} disabled={!editable || busy} onChange={e => setModel(e.target.value)} placeholder="粘贴模型 ID 或 ep-…"/></Field>
          <Field label="Seedance API Key" hint={value.seedance.configured ? `已加密保存 · 末尾 ${value.seedance.suffix}；留空保留当前密钥` : IS_WEB ? '由本地登录密码加密保存在浏览器；联网调用时临时解密。' : '使用 Windows 当前用户加密，仅在这台电脑上使用。'}><input type="password" autoComplete="off" disabled={!editable || !value.seedance.supported || busy} maxLength={512} value={seedKey} onChange={e => setSeedKey(e.target.value)} placeholder={value.seedance.configured ? '留空保留现有密钥' : '填写官方 API Key'}/></Field>
          <div className="service-fields"><Field label="每段视频预算预留（美元）"><input type="number" min={0.1} max={100} step={0.1} value={reservation} disabled={!editable || busy} onChange={e => setReservation(Number(e.target.value))}/></Field><Field label="视频单价（美元 / 百万 token）"><input type="number" min={0} max={1000} step={0.01} value={price} disabled={!editable || busy} onChange={e => setPrice(Number(e.target.value))}/></Field></div>
          <p className="small-note">请按自己账户的型号与音频档位填写单价；人民币报价请先换算。填 0 时只记录预算预留。预留金额用于项目预算检查，不是服务商收费上限。</p>
          <button className="button primary full" disabled={!editable || busy || !model.trim() || (!value.seedance.configured && !seedKey.trim())}><LockKeyhole size={16}/>保存视频连接</button>
        </form>
        {value.seedance.problem && <p className="error-text">{value.seedance.problem}</p>}
        {value.seedance.configured && <button className="text-button muted" disabled={busy || !editable} onClick={() => setDeleteService('seedance')}>删除 Seedance 本机密钥</button>}
        <a className="service-doc" href={region === 'volcengine' ? 'https://www.volcengine.com/docs/82379/1520757' : 'https://docs.byteplus.com/en/docs/ModelArk/1520757'} target="_blank" rel="noreferrer">Seedance 官方接口说明 ↗</a>
      </article>
      <article className="service-card"><div className="service-title"><Link2 size={21}/><h3>抖音发布与评论</h3><Pill color={value.douyin.accounts.length ? 'green' : 'gray'}>{value.douyin.accounts.length ? '账号已授权' : '待授权'}</Pill></div>
        <p>支持视频定时投稿、审核状态查询，以及自有公开作品的评论同步。需要开放平台应用审核和账号授权。</p>
        <form autoComplete="off" onSubmit={e => { e.preventDefault(); const submitted = { clientKey, clientSecret, redirectUri: redirect }; setClientKey(''); setClientSecret(''); setAuthorizeUrl(''); setCallback(''); void run(async () => { await api('/integrations/douyin', 'PUT', submitted); await changed(); notify('应用凭证已加密保存，接下来授权自己的抖音账号'); }); }}>
          <Field label="抖音 Client Key" hint={value.douyin.configured ? `应用已保存 · 末尾 ${value.douyin.clientKeySuffix}；替换应用后需重新授权。` : '在抖音开放平台创建并审核应用后获取。'}><input autoComplete="off" required disabled={!editable || !value.douyin.supported || busy} value={clientKey} onChange={e => setClientKey(e.target.value)} maxLength={512}/></Field>
          <Field label="抖音 Client Secret"><input type="password" autoComplete="off" required disabled={!editable || !value.douyin.supported || busy} value={clientSecret} onChange={e => setClientSecret(e.target.value)} maxLength={512}/></Field>
          <Field label="平台注册的回调地址" hint="必须与开发者后台一致。平台若不接受本地地址，请填已注册的 HTTPS 地址；授权后复制地址栏中的完整回调地址。"><input type="url" required value={redirect} onChange={e => setRedirect(e.target.value)} disabled={!editable || busy} maxLength={2048}/></Field>
          <button className="button primary full" disabled={!editable || busy || !clientKey.trim() || !clientSecret.trim()}><KeyRound size={16}/>{value.douyin.configured ? '替换应用凭证' : '加密保存应用凭证'}</button>
        </form>
        <div className="authorization-step"><h4>授权自己的账号</h4><p className="small-note">所需权限：video.create、video.data、item.comment。授权码和令牌不会进入项目备份。</p>
          {state.accounts.filter(a => a.platform === 'douyin').map(account => { const connected = value.douyin.accounts.find(a => a.id === account.id); return <div className="authorized-account" key={account.id}><div><b>{account.name}</b><small>{connected ? `已授予：${connected.scopes.join('、')}` : '尚未完成平台授权'}</small>{connected && <small>授权有效期至 {new Date(connected.expiresAt).toLocaleString('zh-CN')} · 支持自动续期</small>}</div><button className="button small" disabled={busy || !editable || !value.douyin.configured} onClick={() => void run(async () => { const result = await api<{ url: string }>('/integrations/douyin/authorize', 'POST', { accountId: account.id }); setAuthorizeUrl(result.url); setCallback(''); })}>{connected ? '重新授权' : '准备授权'}</button></div>; })}
          {authorizeUrl && <div className="oauth-complete"><a className="button full" href={authorizeUrl} target="_blank" rel="noreferrer">打开抖音，确认授权 ↗</a><Field label="授权后的完整回调地址" hint="完成授权后复制地址栏，15 分钟内粘贴。此地址含一次性授权码，提交后清空。"><input type="password" autoComplete="off" value={callback} onChange={e => setCallback(e.target.value)} maxLength={8192}/></Field><button className="button primary full" disabled={busy || !callback.trim()} onClick={() => { const submitted = callback; setCallback(''); void run(async () => { await api('/integrations/douyin/complete', 'POST', { callbackUrl: submitted }); setAuthorizeUrl(''); await changed(); notify('平台授权已保存，请核对显示的权限'); }); }}>完成账号连接</button></div>}
        </div>
        {value.douyin.configured && <button className="text-button muted" disabled={!editable || busy} onClick={() => setDeleteService('douyin')}>删除应用凭证并停止自动任务</button>}
        <a className="service-doc" href="https://open.douyin.com/platform/resource/docs/develop/permission/web/oauth2" target="_blank" rel="noreferrer">抖音官方授权说明 ↗</a>
      </article>
    </div>
    <div className="platform-boundary"><b>小红书</b><p>目前保留素材导出、手动发布和评论导入。查到的官方分享 SDK 需要在小红书客户端完成发布，尚未找到可据此接入的通用后台发笔记及评论采集接口。</p><a href="https://agora.xiaohongshu.com/doc" target="_blank" rel="noreferrer">查看官方分享文档 ↗</a></div>
    {!editable && <p className="info-box">个人凭证由运行服务的电脑保管。请在该电脑的本地地址完成配置与自动任务授权。</p>}
    {deleteService && <div className="info-box delete-key"><p>删除{deleteService === 'douyin' ? '抖音凭证会停止后续自动发布和评论同步，平台中已有作品保留。平台授权可另外在抖音中撤销。' : ' Seedance 密钥后，需重新填写才能生成视频。'}</p><button className="button danger small" disabled={busy} onClick={() => void run(async () => { await api(`/integrations/${deleteService}`, 'DELETE'); setDeleteService(''); await changed(); notify('本机凭证已删除'); })}>确认删除</button><button className="button small" onClick={() => setDeleteService('')}>保留</button></div>}
  </section>;
}
