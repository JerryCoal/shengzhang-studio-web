const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keyed = rows => rows.every(row => isRecord(row) && typeof row.id === 'string') && new Set(rows.map(row => row.id)).size === rows.length;
// Apply only fields changed by this operation. Edits made meanwhile stay local.
function merge(base, remote, current) {
  if (same(base, remote)) return structuredClone(current);
  if (same(base, current)) return structuredClone(remote);
  if (same(remote, current)) return structuredClone(current);
  if ([base, remote, current].every(Array.isArray) && [base, remote, current].every(keyed)) {
    const before = new Map(base.map(v => [v.id, v])), after = new Map(remote.map(v => [v.id, v]));
    const result = current.flatMap(value => {
      if (!before.has(value.id)) return [value];
      if (!after.has(value.id)) { if (!same(value, before.get(value.id))) throw new Error('结果与本地编辑冲突'); return []; }
      return [merge(before.get(value.id), after.get(value.id), value)];
    });
    for (const value of remote) if (!before.has(value.id)) {
      const existing = result.find(v => v.id === value.id);
      if (existing && !same(existing, value)) throw new Error('结果与本地编辑冲突');
      if (!existing) result.push(structuredClone(value));
    }
    return result;
  }
  if ([base, remote, current].every(isRecord)) {
    const result = structuredClone(current);
    for (const key of new Set([...Object.keys(base), ...Object.keys(remote)])) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('无效结果字段');
      if (key === 'revision' && [base[key], remote[key], current[key]].every(Number.isInteger)) { result[key] = Math.max(current[key], remote[key]) + (same(base[key], remote[key]) ? 0 : 1); continue; }
      if (key === 'updatedAt' && [base[key], remote[key], current[key]].every(v => typeof v === 'string')) { result[key] = [remote[key], current[key]].sort().at(-1); continue; }
      const value = merge(base[key], remote[key], current[key]);
      if (value === undefined) delete result[key]; else result[key] = value;
    }
    return result;
  }
  throw new Error('结果与本地编辑冲突');
}
export function mergeRelayState(base, remote, current) {
  const next = structuredClone(current);
  for (const key of ['projects', 'accounts']) next[key] = merge(base[key], remote[key], current[key]);
  const old = new Set(base.activities.map(a => a.id));
  next.activities = [...remote.activities.filter(a => !old.has(a.id)), ...current.activities].filter((v, i, rows) => rows.findIndex(row => row.id === v.id) === i).slice(0, 100);
  return next;
}
