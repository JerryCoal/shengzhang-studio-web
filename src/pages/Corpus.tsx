import { useState } from 'react';
import { BookOpen, FileText, Search, Upload, Trash2 } from 'lucide-react';
import { useStudio } from '../context';
import { api } from '../api';
import { readDocument } from '../document-text';
import { corpusQuery } from '../../server/workflow.mjs';
import { Empty, Field, Modal, NeedProject, PageTitle } from '../components';
import type { CorpusDocument, CorpusReference, CopyReview } from '../types';

export function RetrievalResults({ results }: { results: CorpusReference[] }) {
  return <div className="retrieval-results">{results.map(ref => <article key={`${ref.documentId}:${ref.chunk}`}><b><FileText size={15}/>{ref.name} · 段落 {ref.chunk}</b><p>{ref.text}</p></article>)}</div>;
}
export function CopyReviewNote({ review }: { review?: CopyReview }) {
  if (!review) return null;
  const hits = review.hits.length ? review.hits : review.previousHits || [];
  return <details className="copy-review"><summary>{hits.length ? `敏感词筛选完成 · ${hits.reduce((n, h) => n + h.count, 0)} 处替换记录` : `敏感词筛选完成 · 未命中 ${review.rulesCount} 条启用词条`}</summary><p>按当前词库进行文字匹配；替换后请检查语义和产品事实，不代表平台审核结果。</p>{hits.map((hit, i) => <div key={i}><b>{hit.original}</b> → <span>{hit.replacement || '删除该词'}</span><small>{hit.field} · {hit.count} 处</small></div>)}</details>;
}
export function GenerationWorkflow() { return <div className="generation-workflow" aria-label="生成工作流程"><span>1 检索项目语料</span><span>2 生成策略与文案</span><span>3 筛选并替换敏感词</span><span>4 检查成品</span></div>; }

export function CorpusPage() {
  const { project, mutate, run, busy, notify } = useStudio();
  const [open, setOpen] = useState(false), [reading, setReading] = useState(false);
  const [name, setName] = useState(''), [text, setText] = useState(''); const [importError, setImportError] = useState('');
  const [format, setFormat] = useState<CorpusDocument['format']>('paste');
  const [query, setQuery] = useState(project ? corpusQuery(project) : '');
  const [results, setResults] = useState<CorpusReference[] | null>(null), [preview, setPreview] = useState<CorpusDocument | null>(null), [deleting, setDeleting] = useState<CorpusDocument | null>(null);
  if (!project) return <NeedProject/>;
  const documents = project.corpus || [];
  return <>
    <PageTitle title="项目语料库" subtitle="把介绍文档保存在当前项目，生成前检索相关段落并保留出处。"><button className="button primary" onClick={() => { setName(''); setText(''); setImportError(''); setFormat('paste'); setOpen(true); }}><Upload size={17}/>导入项目介绍</button></PageTitle>
    <GenerationWorkflow/>
    <section className="panel corpus-search"><div className="section-heading"><h2><Search size={18}/>查询语料库</h2><span>{documents.filter(d => d.enabled).length} 份参与检索</span></div><form onSubmit={e => { e.preventDefault(); void run(async () => { const value = await api<{ results: CorpusReference[] }>(`/projects/${project.id}/corpus/search`, 'POST', { query }); setResults(value.results); }); }}><Field label="想查找什么"><input value={query} maxLength={500} placeholder="例如：产品规格、使用步骤、品牌定位" onChange={e => setQuery(e.target.value)}/></Field><button className="button primary" disabled={busy || !query.trim()}><Search size={16}/>查询相关段落</button></form><p className="small-note">本地按关键词匹配，最多返回 5 段。只检索当前项目已启用的文档，不调用外部模型。</p>{results && (results.length ? <RetrievalResults results={results}/> : <p className="empty-search">没有找到相关段落，请换一个关键词或补充文档。</p>)}</section>
    <div className="section-heading"><h2>已保存的介绍文档</h2><span className="muted">{documents.length} / 50 份</span></div>
    {documents.length ? <div className="corpus-list">{documents.map(doc => <article className="panel corpus-document" key={doc.id}><div><FileText size={24}/><h3>{doc.name}</h3><small>{doc.format.toUpperCase()} · {doc.text.length.toLocaleString()} 字符 · {doc.chunks.length} 段 · {new Date(doc.importedAt).toLocaleDateString('zh-CN')}</small><p>{doc.text.slice(0, 130)}{doc.text.length > 130 ? '…' : ''}</p></div><div className="row gap-12 wrap"><label className="checkbox-row"><input type="checkbox" checked={doc.enabled} disabled={busy} onChange={e => { const enabled = e.target.checked; void run(async () => { await mutate(`/projects/${project.id}/corpus/${doc.id}`, 'PATCH', { enabled }); setResults(null); }); }}/><span>参与检索</span></label><button className="button small" onClick={() => setPreview(doc)}><BookOpen size={15}/>查看正文</button><button className="icon-button" disabled={busy} aria-label={`删除语料 ${doc.name}`} onClick={() => setDeleting(doc)}><Trash2 size={16}/></button></div></article>)}</div> : <div className="panel"><Empty title="把项目资料放进来" text="支持 TXT、MD、DOCX 和文字型 PDF，也可以直接粘贴介绍。保存提取的正文与来源，原文件保留在你的文件夹。"/></div>}
    {open && <Modal title="导入项目介绍文档" description="在本机提取正文，检查后再保存到项目语料库。" onClose={() => { if (!reading) setOpen(false); }} wide><label className="button file-button"><Upload size={16}/>{reading ? '正在读取文档…' : '选择介绍文档'}<input type="file" aria-label="选择项目介绍文档" accept=".txt,.md,.docx,.pdf" disabled={reading} onChange={async e => { const file = e.target.files?.[0]; e.target.value = ''; if (!file) return; setReading(true); setImportError(''); try { const result = await readDocument(file); setName(file.name); setText(result.text); setFormat(result.format); } catch (error) { setImportError(error instanceof Error ? error.message : '文档读取失败'); } finally { setReading(false); } }}/></label><p className="small-note">单文件 8 MB，正文最多 30 万字符。PDF 最多 100 页；扫描件需先转为文字。</p><div role="alert" className="error-text">{importError}</div><Field label="语料名称"><input value={name} maxLength={160} onChange={e => setName(e.target.value)} placeholder="例如：咖啡产品介绍 2026年9月"/></Field><Field label="正文预览与补充"><textarea value={text} rows={12} maxLength={300000} onChange={e => setText(e.target.value)} placeholder="也可以直接粘贴项目介绍…"/></Field><p className="small-note">文档内容只作为参考资料。生成时只发送检索命中的段落；产品事实与冲突信息仍需人工核对。</p><div className="modal-actions"><button className="button" disabled={reading} onClick={() => setOpen(false)}>取消</button><button className="button primary" disabled={busy || reading || !name.trim() || !text.trim()} onClick={() => void run(async () => { await mutate(`/projects/${project.id}/corpus`, 'POST', { name, text, format }); setOpen(false); setResults(null); notify('介绍文档已保存，生成前会检索相关段落'); })}>确认导入语料</button></div></Modal>}
    {preview && <Modal title={preview.name} onClose={() => setPreview(null)} wide><pre className="corpus-fulltext">{preview.text}</pre></Modal>}
    {deleting && <Modal title="删除这份语料" description="以后生成时不再检索它；已保存策略的引用快照仍然保留。" onClose={() => setDeleting(null)}><p>{deleting.name}</p><div className="modal-actions"><button className="button" onClick={() => setDeleting(null)}>保留</button><button className="button danger" disabled={busy} onClick={() => void run(async () => { await mutate(`/projects/${project.id}/corpus/${deleting.id}`, 'DELETE'); setDeleting(null); setResults(null); })}>删除语料</button></div></Modal>}
  </>;
}
