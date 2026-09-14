import { useState } from 'react';
import { Check, Link2, MessageSquareText, RefreshCw, Send, Square } from 'lucide-react';
import { useStudio } from '../context';
import { date, Field, Modal } from '../components';
import type { Publication } from '../types';

const labels: Record<string, string> = { queued: '已启用定时投稿', uploading: '正在上传视频', submitting: '正在创建作品', submitted: '已投稿 · 等待审核', published: '已发布 · 平台确认', uncertain: '结果待核对', failed: '投稿未完成', blocked: '自动投稿已暂停', cancelled: '自动投稿已停止' };
export function publicationStatusLabel(record: Publication) {
  if (record.status === 'published') return record.sample ? '示例作品' : record.confirmationSource === 'douyin-api' ? '已发布 · 平台确认' : '已发布 · 用户确认';
  if (record.status === 'cancelled') return '已取消';
  if (record.automation && record.automation.status !== 'cancelled') return labels[record.automation.status] || '自动流程待检查';
  return record.status === 'exported' ? '已导出，待确认' : '待导出 / 发布';
}
export function PlatformActions({ record }: { record: Publication }) {
  const { project, state, settings, run, mutate, busy, notify } = useStudio();
  const [open, setOpen] = useState(false), [link, setLink] = useState(false), [confirmed, setConfirmed] = useState(false), [text, setText] = useState(record.title.slice(0, 55));
  if (record.platform !== 'douyin' || record.sample || record.status === 'cancelled') return null;
  const account = state.accounts.find(a => a.id === record.accountId), status = record.automation?.status;
  const pending = ['scheduled', 'exported'].includes(record.status), allowed = settings.credential.local;
  return <div className="platform-actions">
    {record.automation?.error && <p className="small-note">{record.automation.error}</p>}
    <div className="row gap-8 wrap">
      {pending && (!status || ['cancelled', 'failed', 'blocked'].includes(status)) && <button className="button primary small" disabled={busy || !allowed} onClick={() => { setConfirmed(false); setOpen(true); }}><Send size={14}/>启用抖音自动发布</button>}
      {status && ['queued', 'blocked', 'failed'].includes(status) && !record.automation?.itemId && <button className="button small" disabled={busy || !allowed} onClick={() => void run(async () => { await mutate(`/projects/${project!.id}/publications/${record.id}/stop-automatic`); notify('后续自动投稿已停止，素材保留'); })}><Square size={13}/>停止自动投稿</button>}
      {pending && record.automation?.itemId && <button className="button small" disabled={busy || !allowed} onClick={() => void run(async () => { await mutate(`/projects/${project!.id}/publications/${record.id}/platform-status`); })}><RefreshCw size={14}/>查询审核结果</button>}
      {!record.platformItemId && !['queued', 'uploading', 'submitting'].includes(status || '') && <button className="button small" disabled={busy || !allowed} onClick={() => setLink(true)}><Link2 size={14}/>关联已有抖音作品</button>}
    </div>
    {open && <Modal title="确认这条视频自动投稿" description="系统将使用下面的成品和文案，向你授权的抖音账号投稿。" onClose={() => setOpen(false)} wide>
      <div className="automatic-preview"><video controls playsInline src={record.mediaData}/><div><h3>{record.title}</h3><p>账号：<b>{record.accountName}</b></p><p>时间：<b>{new Date(record.scheduledAt).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}</b></p><p className="small-note">计划时间已到时，会在下次任务检查时投稿。请保持这台电脑和本地服务运行。</p><Field label="抖音投稿文案（最多 55 字）"><textarea maxLength={55} rows={4} value={text} onChange={e => setText(e.target.value)}/></Field><p className="small-note">此文案只用于本次投稿，不修改原始素材正文。发布后可能需要平台审核。</p></div></div>
      {!account?.autoPublish && <p className="info-box">请先在连接设置完成这个抖音账号的授权，授予视频投稿和作品查询权限。</p>}
      <label className="checkbox-row"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/><span>我已检查视频、文案、账号和时间，授权工作台按此计划自动投稿。</span></label>
      <div className="modal-actions"><button className="button" onClick={() => setOpen(false)}>再检查一下</button><button className="button primary" disabled={busy || !confirmed || !text.trim() || !account?.autoPublish} onClick={() => void run(async () => { await mutate(`/projects/${project!.id}/publications/${record.id}/automatic`, 'POST', { confirmed, text }); setOpen(false); notify('自动发布已安排，请保持本地服务运行'); })}><Send size={16}/>确认并启用自动发布</button></div>
    </Modal>}
    {link && <LinkPlatformItem record={record} onClose={() => setLink(false)}/>}
  </div>;
}
function LinkPlatformItem({ record, onClose }: { record: Publication; onClose: () => void }) {
  const { project, run, mutate, busy, notify } = useStudio(); const [itemId, setItemId] = useState(''), [confirmed, setConfirmed] = useState(false);
  return <Modal title="关联平台中已有的作品" description="查询授权账号中的公开作品，核对成功后可同步评论；不会重新发视频。" onClose={onClose}><Field label="平台返回的 item_id" hint="使用开放平台返回的完整作品编号，通常为加密字符串，和分享链接中的数字不一定相同。"><input value={itemId} onChange={e => setItemId(e.target.value)} maxLength={512}/></Field><label className="checkbox-row"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/><span>我已在抖音确认，此编号对应当前账号的这条作品。</span></label><div className="modal-actions"><button className="button" onClick={onClose}>取消</button><button className="button primary" disabled={busy || !confirmed || !itemId.trim()} onClick={() => void run(async () => { await mutate(`/projects/${project!.id}/publications/${record.id}/platform-item`, 'POST', { itemId, confirmed }); notify('已从抖音核对作品，可开始同步评论'); onClose(); })}><Check size={16}/>查询并关联</button></div></Modal>;
}
export function CommentSyncPanel() {
  const { project, settings, mutate, run, busy, go, notify } = useStudio();
  const [link, setLink] = useState<Publication | null>(null);
  const publications = project!.publications.filter(p => p.platform === 'douyin' && p.status === 'published' && !p.sample);
  return <section className="panel comment-sync-panel"><div className="section-heading"><div><h3><MessageSquareText size={19}/>自动采集评论</h3><p className="muted">通过抖音官方接口采集自有公开作品的一级评论，保留原文、点赞数和发表时间。</p></div><button className="button small" onClick={() => go('settings')}>管理平台授权</button></div>
    {publications.length ? publications.map(pub => <div className="sync-record" key={pub.id}><div><b>{pub.title}</b><small>{pub.platformItemId ? `上次同步：${pub.commentSync?.lastSyncAt ? date(pub.commentSync.lastSyncAt, true) : '尚未同步'}${pub.commentSync?.partial ? ' · 分页采集中' : ''}` : '需要先关联平台作品编号'}</small>{pub.commentSync?.error && <small className="error-text">{pub.commentSync.error}</small>}</div>{pub.platformItemId ? <div className="row gap-10 wrap"><label className="checkbox-row"><input type="checkbox" checked={!!pub.commentSync?.enabled} disabled={busy || !settings.credential.local} onChange={e => { const enabled = e.target.checked; void run(async () => { await mutate(`/projects/${project!.id}/publications/${pub.id}/comments-sync`, 'PUT', { enabled }); notify(enabled ? '自动同步已开启，每 15 分钟检查一次' : '自动同步已关闭'); }); }}/><span>每 15 分钟自动同步</span></label><button className="button small" disabled={busy || !settings.credential.local} onClick={() => void run(async () => { const result = await mutate<{ added: number; partial: boolean }>(`/projects/${project!.id}/publications/${pub.id}/comments-sync`); notify(`新增 ${result.result.added} 条评论${result.result.partial ? '，还有后续分页待同步' : ''}`); })}><RefreshCw size={14}/>立即同步</button></div> : <button className="button small" disabled={busy || !settings.credential.local} onClick={() => setLink(pub)}>关联作品</button>}</div>) : <p className="small-note">完成抖音授权并发布第一条视频后，即可在这里开启自动同步。小红书当前使用评论导入。</p>}
    <p className="small-note">开启自动同步后需保持本地服务运行。每轮最多采集 500 条，更多分页会续采；接口可见范围受平台限制，暂不采集评论下的回复。</p>
    {link && <LinkPlatformItem record={link} onClose={() => setLink(null)}/>}
  </section>;
}
