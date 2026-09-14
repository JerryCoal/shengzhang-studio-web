import { useState } from 'react';
import { api, download } from '../api';
import { useStudio } from '../context';

export function WebRequestStatus() {
  const { settings, busy, run, refresh, notify } = useStudio();
  const [confirmed, setConfirmed] = useState(false);
  if (!settings.pendingWebRequest && !settings.recoveredWebResults) return null;
  return <section className="panel settings-card"><h2>尚需核对的联网结果</h2>
    {settings.pendingWebRequest && <><p>有一项请求尚未确认完成。请先等待当前请求结束；如果页面曾刷新或网络中断，请到对应服务商控制台检查任务、账单或已投稿作品。当前已暂停重复提交。</p><p className="muted">发起时间：{new Date(settings.pendingWebRequest.at).toLocaleString('zh-CN')}</p>
      <label className="checkbox-row"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/><span>我已核对任务和账单；发布状态不明的计划继续暂停，由我重新核对安排。</span></label>
      <button className="button" disabled={busy || !confirmed} onClick={() => void run(async () => { await api('/web/acknowledge', 'POST', { confirmed: true }); await refresh(); setConfirmed(false); notify('请求锁定已解除，请按服务商实际结果继续'); })}>核对后解除请求锁定</button></>}
    {!!settings.recoveredWebResults && <><p>有 {settings.recoveredWebResults} 份结果与后续编辑发生冲突，已在此浏览器加密保留。</p><button className="button" disabled={busy} onClick={() => void run(async () => { const results = await api('/web/recovery'); download(new Blob([JSON.stringify(results, null, 2)], { type: 'application/json' }), '生长-保留的联网结果.json'); notify('保留结果已导出，不包含 API 密钥'); })}>导出保留结果</button></>}
  </section>;
}
