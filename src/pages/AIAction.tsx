import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { Modal, Field } from '../components';
import { useStudio } from '../context';
import type { Stage } from '../types';

export function AIAction({ stage, title, description, path, body = {}, onDone, instruction = false }: { stage: Stage; title: string; description: string; path: string; body?: object; onDone?: () => void; instruction?: boolean }) {
  const { settings, mutate, run, busy, notify, go } = useStudio(); const [open, setOpen] = useState(false); const [text, setText] = useState('');
  const model = settings.routes[stage], rate = settings.models[model];
  return <><button type="button" className="button small" disabled={busy} onClick={() => setOpen(true)}><Sparkles size={15}/>{title}</button>{open && <Modal title={title} description={description} onClose={() => { if (!busy) setOpen(false); }}><div className="setting-row"><span>本次模型</span><b>{rate.label}</b></div><p className="muted">输入 ${rate.inputPrice} / 输出 ${rate.outputPrice} 每百万 token。调用前检查项目预算，失败不替换原内容。</p><div className="info-box">本次所需的项目资料或评论会发送到 OpenAI。结果需人工检查，费用按实际 API 用量结算。</div>{instruction && <Field label="希望怎样修改？"><textarea rows={3} maxLength={2000} value={text} onChange={e => setText(e.target.value)}/></Field>}<div className="modal-actions"><button className="button" disabled={busy} onClick={() => setOpen(false)}>取消</button>{settings.openaiConfigured ? <button className="button primary" disabled={busy} onClick={() => void run(async () => { await mutate(path, 'POST', { ...body, ...(instruction ? { instruction: text } : {}) }); setOpen(false); notify('AI 处理完成，请检查结果'); onDone?.(); })}>{busy ? '处理中…' : '开始 AI 处理'}</button> : <button className="button primary" onClick={() => go('settings')}>前往配置 API</button>}</div></Modal>}</>;
}
