import { canGenerate } from './model-provider';
import { useEffect, useRef, type ReactNode } from 'react';
import { ArrowUpRight, Check, ChevronRight, Leaf, Plus, Sparkles, X } from 'lucide-react';
import type { Platform, Project } from './types';
import { useStudio } from './context';
export const platformName = (platform: Platform) => platform === 'xiaohongshu' ? '小红书' : '抖音';
export const date = (value?: string | null, withTime = false) => value ? new Date(value).toLocaleString('zh-CN', withTime ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false } : { month: 'long', day: 'numeric' }) : '尚未记录';
export function Channel({ platform, compact = false }: { platform: Platform; compact?: boolean }) { return <span className={`channel ${platform}`}><span>{platform === 'xiaohongshu' ? '红' : '♪'}</span>{!compact && platformName(platform)}</span>; }
export function Pill({ children, color = 'green' }: { children: ReactNode; color?: string }) { return <span className={`pill ${color}`}>{children}</span>; }
export function PageTitle({ eyebrow, title, subtitle, children }: { eyebrow?: string; title: string; subtitle: string; children?: ReactNode }) { return <div className="page-title"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1><p>{subtitle}</p></div><div className="page-actions">{children}</div></div>; }
export function Empty({ title, text, children }: { title: string; text: string; children?: ReactNode }) { return <div className="empty"><div className="empty-icon"><Leaf size={28}/></div><h3>{title}</h3><p>{text}</p>{children}</div>; }
export function NeedProject() { const { go } = useStudio(); return <Empty title="先种下一个新项目" text="添加品牌资料与宣传目标，开始你的内容创作。"><button className="button primary" onClick={() => go('projects')}><Plus size={16}/>创建项目</button></Empty>; }
export function Modal({ title, description, children, onClose, wide = false }: { title: string; description?: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); const d = ref.current; return () => d?.close(); }, []);
  return <dialog ref={ref} className={`modal ${wide ? 'wide' : ''}`} onCancel={e => { e.preventDefault(); onClose(); }} onClick={e => { if (e.target === e.currentTarget) onClose(); }} aria-label={title}>
    <div className="modal-head"><div><h2>{title}</h2>{description && <p>{description}</p>}</div><button className="icon-button" onClick={onClose} aria-label="关闭弹窗"><X size={20}/></button></div><div className="modal-body">{children}</div>
  </dialog>;
}
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) { return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>; }
export function ProductArt({ project, small = false }: { project?: Project; small?: boolean }) {
  if (project?.imageData) return <div className={`product-art photo ${small ? 'small' : ''}`}><img src={project.imageData} alt={`${project.brief.product}参考素材`}/></div>;
  return <div className={`product-art ${small ? 'small' : ''}`} aria-label="品牌概念插画"><div className="art-orbit"/><div className="art-ground"/><div className="art-leaf leaf-one"/><div className="art-leaf leaf-two"/><div className="coffee-bag"><span>{project?.brief.brand || '生 长'}</span><small>THE SLOW MOMENTS</small><svg viewBox="0 0 160 90" aria-hidden="true"><path d="M0 82L38 18L65 52L100 5L160 82M32 80L68 30L111 83"/></svg><b>{project?.brief.product || '让好想法慢慢生长'}</b><i>MADE FOR EVERYDAY</i></div><div className="art-cup"><span/></div><div className="art-spark">✳</div></div>;
}
export function ProjectCard({ project }: { project: Project }) {
  const { go } = useStudio(); const p = project; const latest = p.strategies.at(-1); const ready = p.assets.filter(a => a.status === 'ready').length;
  return <article className="project-card"><button className="card-art-button" onClick={() => go('strategy', p.id)} aria-label={`打开项目 ${p.brief.name}`}><ProductArt project={p}/><span className="art-badge">{p.brief.type === 'launch' ? '新品上市' : '日常传播'}</span></button><div className="project-card-body"><div className="row between"><small className="muted">{p.brief.brand}</small>{p.sample && <Pill color="gray">示例项目</Pill>}</div><button className="text-button card-title" onClick={() => go('strategy', p.id)}>{p.brief.name}<ArrowUpRight size={18}/></button><p className="clamp-2">{p.brief.goal}</p><div className="row gap-8">{p.brief.channels.map(c => <Channel key={c} platform={c}/>)}</div><div className="card-divider"/><div className="row between"><span className="project-status"><span className="dot"/>{latest?.status === 'confirmed' ? `${ready}/${p.assets.length} 份内容已完成` : latest ? '策略待确认' : '待生成策略'}</span><small className="muted">{date(p.brief.deadline)} 截止</small></div></div></article>;
}
const steps = [{ label: '项目资料', page: 'projects' }, { label: '策略确认', page: 'strategy' }, { label: '内容制作', page: 'studio' }, { label: '发布中心', page: 'publish' }, { label: '评论复盘', page: 'comments' }, { label: '下期策划', page: 'planning' }] as const;
export function Workflow({ project }: { project: Project }) {
  const { go } = useStudio(); const flags = [true, project.strategies.some(s => s.status === 'confirmed'), project.assets.some(a => a.status === 'ready'), project.publications.some(p => p.status === 'published' && !p.sample), project.insights.length > 0, project.experiences.some(e => e.active)];
  const current = flags.indexOf(false);
  return <div className="workflow">{steps.map((step, i) => <button key={step.page} onClick={() => go(step.page, project.id)} className={`${flags[i] ? 'complete' : ''} ${i === current ? 'current' : ''}`}><span className="step-number">{flags[i] ? <Check size={16}/> : String(i + 1).padStart(2, '0')}</span><span>{step.label}</span>{i < 5 && <ChevronRight className="step-arrow" size={14}/>}</button>)}</div>;
}
export function ModeNotice() { const { settings } = useStudio(); return <div className="mode-notice"><Sparkles size={16}/><span>{canGenerate(settings, 'strategy') ? `${settings.model} 已配置 · 生成前按项目预算检查额度` : '本地体验模式 · 策略来自模板，图片与视频由本地素材合成'}</span></div>; }
