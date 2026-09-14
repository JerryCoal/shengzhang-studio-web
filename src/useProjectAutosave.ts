import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { Brief, EditorDraft, Project, State } from './types';

type Saved = { draft: EditorDraft; project: Pick<Project, 'id' | 'brief' | 'revision'> | null };
export function useProjectAutosave(initial: Brief, existing?: Project) {
  const [brief, setBrief] = useState(initial);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState('正在恢复本地草稿…');
  const [error, setError] = useState(false);
  const control = useRef({ key: existing?.id || 'new', latest: initial, saved: JSON.stringify(initial), version: 0, baseBrief: existing?.brief, ready: false, mounted: true, stopped: false, pending: null as Promise<Saved | undefined> | null, result: undefined as Saved | undefined, timer: undefined as ReturnType<typeof setTimeout> | undefined });
  const report = (message: string, failed = false) => { if (control.current.mounted) { setStatus(message); setError(failed); } };
  const flush = (): Promise<Saved | undefined> => {
    const c = control.current; clearTimeout(c.timer);
    if (c.pending) return c.pending.then(() => flush());
    if (!c.ready || c.stopped || JSON.stringify(c.latest) === c.saved) return Promise.resolve(c.result);
    const snapshot = structuredClone(c.latest); const serialized = JSON.stringify(snapshot);
    report('正在自动保存…');
    c.pending = api<Saved>(`/editor-drafts/${c.key}`, 'PUT', { brief: snapshot, expectedVersion: c.version, baseBrief: c.baseBrief }, { keepalive: true }).then(result => {
      c.version = result.draft.version; c.baseBrief = result.draft.baseBrief; c.saved = serialized; c.result = result;
      report(result.draft.conflict ? '资料已在其他窗口修改；当前输入已保存为草稿，请核对后再编辑。' : `${result.draft.applied ? '项目已自动保存' : '草稿已自动保存'} · ${new Date(result.draft.savedAt).toLocaleTimeString('zh-CN')}`, result.draft.conflict);
      return result;
    }).catch(e => { report(`自动保存失败：${e.message}。请重试后关闭。`, true); throw e; }).finally(() => { c.pending = null; });
    return c.pending.then(result => JSON.stringify(c.latest) !== c.saved ? flush() : result);
  };
  useEffect(() => {
    const c = control.current; c.mounted = true; let active = true;
    void api<EditorDraft | null>(`/editor-drafts/${c.key}`).then(draft => {
      if (!active) return;
      if (draft) { c.latest = draft.brief; c.saved = JSON.stringify(draft.brief); c.version = draft.version; c.baseBrief = draft.baseBrief; c.result = { draft, project: existing ? { id: existing.id, brief: existing.brief, revision: existing.revision } : null }; setBrief(draft.brief); }
      const conflict = !!draft && !!existing && JSON.stringify(draft.baseBrief) !== JSON.stringify(existing.brief);
      if (conflict && c.result) c.result.draft = { ...c.result.draft, conflict: true };
      c.ready = true; setReady(true); report(conflict ? '已恢复草稿，但项目资料在其他窗口有更新。请核对，或恢复最新项目资料。' : draft ? '已恢复上次自动保存的草稿' : '输入后自动保存到当前用户的本地工作区', conflict);
    }).catch(e => report(`无法读取草稿：${e.message}。请重新打开编辑窗口。`, true));
    const beforeUnload = (e: BeforeUnloadEvent) => { if (c.ready && !c.stopped && (c.pending || JSON.stringify(c.latest) !== c.saved)) { void flush().catch(() => {}); e.preventDefault(); e.returnValue = ''; } };
    const pageHide = () => { void flush().catch(() => {}); };
    window.addEventListener('beforeunload', beforeUnload); window.addEventListener('pagehide', pageHide);
    return () => { active = false; c.mounted = false; clearTimeout(c.timer); window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('pagehide', pageHide); void flush().catch(() => {}); };
  }, []);
  const set = <K extends keyof Brief>(key: K, value: Brief[K]) => {
    const c = control.current; c.latest = { ...c.latest, [key]: value }; setBrief(c.latest); report('有新修改，准备保存…'); clearTimeout(c.timer); c.timer = setTimeout(() => { void flush().catch(() => {}); }, 250);
  };
  const discardSavedDraft = async () => {
    const c = control.current; await flush();
    if (c.version) await api(`/editor-drafts/${c.key}`, 'DELETE', { expectedVersion: c.version });
    c.stopped = true;
  };
  const restoreCurrent = async () => {
    const c = control.current; clearTimeout(c.timer); await c.pending?.catch(() => {});
    const state = await api<State>('/state'), p = state.projects.find(p => p.id === c.key);
    if (!p) throw new Error('项目不存在，请重新打开');
    c.version = state.projectDrafts?.[c.key]?.version || 0; c.baseBrief = p.brief; c.latest = p.brief; c.saved = ''; setBrief(p.brief); await flush();
  };
  return { brief, set, ready, status, error, flush, discardSavedDraft, restoreCurrent };
}
