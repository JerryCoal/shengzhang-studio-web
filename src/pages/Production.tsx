import { useState } from 'react';
import { Check, Film, ImagePlus, RefreshCw } from 'lucide-react';
import { useStudio } from '../context';
import { Field, Modal, Pill } from '../components';
import type { Asset } from '../types';
import { useIntegrations } from './Integrations';

const phases: Record<string, string> = { frames: '检查关键帧', 'generating-frame': 'GPT Image 2 正在画关键帧', 'submitting-video': '正在提交 Seedance', 'generating-video': 'Seedance 正在生成视频', complete: '视频已保存为成品', failed: '任务未完成', uncertain: '需要核对服务商结果', stale: '内容版本已更新' };
export function ProductionButton({ asset }: { asset: Asset }) {
  const [open, setOpen] = useState(false);
  return <><button className="button primary small" onClick={() => setOpen(true)}><Film size={15}/>{asset.aiProduction ? phases[asset.aiProduction.phase] || '查看 AI 视频' : 'AI 视频 · 首尾帧'}</button>{open && <ProductionDialog assetId={asset.id} onClose={() => setOpen(false)}/>}</>;
}
function ProductionDialog({ assetId, onClose }: { assetId: string; onClose: () => void }) {
  const { project, settings, run, mutate, busy, notify, go } = useStudio();
  const { value, error } = useIntegrations();
  const a = project!.assets.find(a => a.id === assetId)!;
  const initial = `${project!.brief.product}，${project!.brief.requirements}。${a.scenes[0] || a.title}`;
  const [first, setFirst] = useState(a.aiProduction?.frames.find(f => f.role === 'first_frame')?.prompt || `${initial}。开场全景，产品清晰可辨，竖屏构图。`);
  const [last, setLast] = useState(a.aiProduction?.frames.find(f => f.role === 'last_frame')?.prompt || `${initial}。同一场景、同一产品，结束时镜头靠近产品，自然收束。`);
  const [prompt, setPrompt] = useState(`从首帧自然过渡到尾帧。${a.scenes.join('；')}。镜头平稳，产品外观和包装保持一致，不添加未经核实的功效或价格。`);
  const [quality, setQuality] = useState('medium'), [duration, setDuration] = useState(8), [sound, setSound] = useState(true), [approvedFrames, setApprovedFrames] = useState(''), [reset, setReset] = useState(false);
  const g = a.aiProduction, ongoing = ['generating-frame', 'submitting-video', 'generating-video'].includes(g?.phase || '');
  const framesSignature = g?.frames.map(f => f.id).join(',') || '', approved = !!framesSignature && approvedFrames === framesSignature;
  const canFrame = settings.openaiConfigured && !ongoing && g?.phase !== 'uncertain' && (!g?.taskId || g.phase === 'complete') && !busy;
  const makeFrame = (role: 'first_frame' | 'last_frame') => void run(async () => { setApprovedFrames(''); await mutate(`/projects/${project!.id}/assets/${a.id}/keyframes`, 'POST', { role, prompt: role === 'first_frame' ? first : last, quality, expectedRevision: a.revision }); notify('已开始生成关键帧，可以关闭窗口，任务会继续'); });
  return <Modal title="从关键帧，生成一段好视频" description="GPT Image 2 → 检查首尾帧 → Seedance → 本地视频成品" onClose={onClose} wide>
    <div className="production-summary"><Pill color={ongoing ? 'amber' : g?.phase === 'complete' ? 'green' : 'gray'}>{g ? phases[g.phase] : '准备画面'}</Pill><span>9:16 · 关键帧 864 × 1536 · 视频 720p</span></div>
    {(!settings.openaiConfigured || !value?.seedance.configured || !value.seedance.model) && <div className="info-box"><span>{error || '生成关键帧需要 OpenAI 密钥；提交视频还需要 Seedance 密钥和已开通的模型。'}</span><button className="button small" onClick={() => { onClose(); go('settings'); }}>前往连接设置</button></div>}
    <p className="small-note">{project!.imageData ? '会把已上传的产品图作为参考；尾帧还会参考首帧。请检查产品外观和文字。' : '尚未上传产品参考图。可先在内容制作上传产品图，以便生成画面参考真实外观。'} 每张关键帧预留 $1，完成后按返回用量估算费用。</p>
    <Field label="关键帧质量"><select value={quality} onChange={e => setQuality(e.target.value)} disabled={busy || ongoing}><option value="low">快速草稿 · low</option><option value="medium">均衡 · medium</option><option value="high">精细 · high</option></select></Field>
    <div className="keyframe-grid">{(['first_frame', 'last_frame'] as const).map((role, index) => { const frame = g?.frames.find(f => f.role === role); return <article className="keyframe-card" key={role}><div className="keyframe-preview">{frame ? <img src={frame.mediaData} alt={index ? '生成的尾帧' : '生成的首帧'}/> : <div><ImagePlus size={28}/><span>{index ? '02 尾帧' : '01 首帧'}</span></div>}</div><Field label={index ? '尾帧画面要求' : '首帧画面要求'}><textarea rows={4} maxLength={4000} value={index ? last : first} onChange={e => index ? setLast(e.target.value) : setFirst(e.target.value)} disabled={busy || ongoing}/></Field><button className="button full" disabled={!canFrame || !(index ? last : first).trim() || (index === 1 && !g?.frames.some(f => f.role === 'first_frame'))} onClick={() => makeFrame(role)}><ImagePlus size={16}/>{frame ? '重新生成' : '生成'}{index ? '尾帧' : '首帧'} · Image 2</button></article>; })}</div>
    <div className="video-production-options"><h3>把两张画面连成故事</h3><Field label="视频动作与运镜"><textarea rows={3} maxLength={4000} value={prompt} onChange={e => setPrompt(e.target.value)} disabled={ongoing || busy}/></Field><div className="service-fields"><Field label="视频时长"><select value={duration} disabled={ongoing || busy} onChange={e => setDuration(Number(e.target.value))}><option value={5}>5 秒 · 快速试片</option><option value={8}>8 秒 · 均衡</option><option value={12}>12 秒 · 完整短片</option></select></Field><Field label="声音"><select value={sound ? 'yes' : 'no'} disabled={ongoing || busy} onChange={e => setSound(e.target.value === 'yes')}><option value="yes">Seedance 生成同步声音</option><option value="no">静音视频</option></select></Field></div>
      <label className="checkbox-row"><input type="checkbox" checked={approved} disabled={ongoing || busy || g?.frames.length !== 2} onChange={e => setApprovedFrames(e.target.checked ? framesSignature : '')}/><span>我已检查两张关键帧，确认产品外观、文字和场景可以用于视频生成。</span></label>
      <p className="small-note">本次 Seedance 预留 ${value?.seedance.reservationUsd.toFixed(2) || '—'}，实际费用以平台账单为准。成品会自动下载到本地，后续发布需单独确认。</p>
      <button className="button primary full" disabled={busy || ongoing || !approved || !value?.seedance.configured || !value.seedance.model || !value.local || !prompt.trim() || !['frames', 'failed'].includes(g?.phase || '') || !!g?.taskId || a.revision !== g?.assetRevision} onClick={() => void run(async () => { await mutate(`/projects/${project!.id}/assets/${a.id}/seedance`, 'POST', { productionId: g!.id, expectedRevision: a.revision, prompt, duration, generateAudio: sound, confirmed: true }); notify('Seedance 视频任务已提交，成品会自动保存'); })}><Film size={17}/>确认画面并生成视频</button>
    </div>
    {g?.taskId && <div className="job-detail"><span>任务编号：{g.taskId}</span><button className="button small" disabled={busy || ongoing && g.phase !== 'generating-video'} onClick={() => void run(async () => { await mutate(`/projects/${project!.id}/assets/${a.id}/video-status`); })}><RefreshCw size={14}/>查询 / 重新下载</button></div>}
    {g?.error && <p className="info-box" role="status">{g.error}</p>}
    {(g?.phase === 'complete' && a.mediaData || g?.resultMediaData) && <video className="generated-video" controls playsInline src={g?.resultMediaData || a.mediaData}/>}
    {g?.resultMediaData && <button className="button" disabled={busy} onClick={() => void run(async () => { await mutate(`/projects/${project!.id}/assets/${a.id}`, 'PUT', { title: a.title, body: a.body, expectedRevision: a.revision, mediaData: g.resultMediaData, mime: 'video/mp4' }); notify('已将此视频保存为当前文案的新成品'); })}><Check size={16}/>将此视频用于当前文案</button>}
    {g && ['uncertain', 'failed', 'complete', 'stale'].includes(g.phase) && <details className="generation-reset"><summary>核对后开始新的生成</summary><p className="small-note">请先在服务商控制台核对旧任务的完成情况和费用。解除锁定不会取消旧任务，新生成会单独收费。</p><label className="checkbox-row"><input type="checkbox" checked={reset} onChange={e => setReset(e.target.checked)}/><span>已核对旧任务，我要重新生成。</span></label><button className="button" disabled={!reset || busy} onClick={() => void run(async () => { await mutate(`/projects/${project!.id}/assets/${a.id}/generation-reset`, 'POST', { confirmed: true }); setReset(false); setApprovedFrames(''); })}>解除旧任务锁定</button></details>}
  </Modal>;
}
