import { createHash } from 'node:crypto';

export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
}
export const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}
export type Eligible = { id: string; agentId: string; state: string; reviewedRevision: number; currentWake: number;
  reviewedWake: number; firstInterestedAt: number; notBefore: number; directed: boolean };
export function selectCandidate(candidates: Eligible[], revision: number, now: number, agingMs: number,
  graceTargets: string[] = [], graceUntil = 0): Eligible | undefined {
  const valid = candidates.filter(c => c.state === 'READY' && c.reviewedRevision === revision &&
    c.reviewedWake === c.currentWake && c.notBefore <= now);
  const rank = (c: Eligible) => now - c.firstInterestedAt >= agingMs ? 0 : c.directed ? 1 : 2;
  return valid.filter(c => now >= graceUntil || !graceTargets.length || graceTargets.includes(c.agentId) || rank(c) === 0)
    .sort((a, b) => rank(a) - rank(b) || a.firstInterestedAt - b.firstInterestedAt ||
      a.notBefore - b.notBefore || a.id.localeCompare(b.id))[0];
}
export function coalesceDue(pendingSince: number | null, previousDue: number | null, now: number,
  debounceMs: number, maxWaitMs: number): { since: number; due: number } {
  const since = pendingSince ?? now;
  return { since, due: Math.min(now + debounceMs, since + maxWaitMs, previousDue ?? Infinity) };
}
export function retryDelay(errors: number): number { return Math.min(30000, 1000 * 2 ** Math.min(errors, 5)); }
