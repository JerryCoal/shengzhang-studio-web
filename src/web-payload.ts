import { corpusQuery, searchCorpus } from '../server/workflow.mjs';
import type { State } from './types';

export function webPayload(source: State, path: string, body: unknown, projectId?: string): State {
  const base = structuredClone(source); delete base.webPrivate; delete base.projectDrafts; base.activities = [];
  base.projects = projectId ? base.projects.filter(p => p.id === projectId) : [];
  const p = base.projects[0]; if (!p) return base;
  const input = (body || {}) as { instruction?: string; query?: string };
  const assetId = path.includes('/assets/') ? path.split('/')[4] : '';
  const publicationId = path.includes('/publications/') ? path.split('/')[4] : '';
  const asset = p.assets.find(a => a.id === assetId), strategy = path.endsWith('/strategies'), copy = path.endsWith('/copy');
  if (strategy || copy) {
    const query = strategy ? input.query || corpusQuery(p, input.instruction || '') : corpusQuery(p, `${asset?.title || ''} ${input.instruction || ''}`);
    const references = searchCorpus(p, query);
    p.corpus = (p.corpus || []).filter(doc => references.some(r => r.documentId === doc.id)).map(doc => {
      const rows = references.filter(r => r.documentId === doc.id);
      return { ...doc, text: rows.map(r => r.text).join('\n'), chunks: rows.map(r => ({ index: r.chunk, text: r.text })) };
    });
  } else p.corpus = [];
  p.audioData = ''; if (!path.endsWith('/keyframes')) p.imageData = '';
  p.assets = path === '/tick' ? p.assets.filter(a => a.aiProduction?.phase === 'generating-video') : asset ? [asset] : [];
  p.strategies = strategy ? p.strategies.slice(-1) : asset ? p.strategies.filter(s => s.id === asset.strategyId) : [];
  p.publications = path === '/tick' ? p.publications.filter(r => ['queued', 'submitted'].includes(r.automation?.status || '') || r.commentSync?.enabled) : publicationId ? p.publications.filter(r => r.id === publicationId) : [];
  if (strategy) {
    p.experiences = p.experiences.filter(e => e.active);
    p.insights = p.insights.filter(i => p.experiences.some(e => e.insightId === i.id));
    p.comments = p.comments.filter(c => p.insights.some(i => i.evidenceIds.includes(c.id)));
  } else {
    p.experiences = []; p.insights = [];
    if (path.endsWith('/classify')) p.comments = p.comments.filter(c => !c.irrelevant && !c.correctedAt && !c.classificationModel).slice(0, 60);
    else if (path.endsWith('/analysis')) p.comments = p.comments.filter(c => !c.irrelevant);
    else p.comments = p.comments.filter(c => p.publications.some(r => r.id === c.publicationId));
  }
  return base;
}
