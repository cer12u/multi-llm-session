import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers.js';
import { ArchiveSession, type ArchiveRead } from '../apps/web/src/archive-session.js';
import type { Page, PublicMessage, Snapshot } from '../packages/contracts/index.js';

type Fixture = ReturnType<typeof fixture>;
function reader(f: Fixture): ArchiveRead {
  return async <T>(path: string, body?: unknown): Promise<T> => {
    const url = new URL(path, 'http://synthetic.invalid');
    const prefix = `/v1/sessions/${f.id}/`;
    if (!url.pathname.startsWith(prefix)) throw new Error('CROSS_SESSION_REQUEST');
    const part = url.pathname.slice(prefix.length);
    const options = { limit: Number(url.searchParams.get('limit') ?? 100), cursor: url.searchParams.get('cursor') };
    let value: unknown;
    if (part === 'snapshot') value = f.service.snapshot(f.id);
    else if (part === 'history') value = f.service.pages.history(f.id, options);
    else if (part === 'search-page') value = f.service.pages.search(f.id, url.searchParams.get('q')!, options);
    else if (part.startsWith('threads/')) value = f.service.pages.thread(f.id, part.slice(8), options);
    else if (part === 'messages/lookup') value = f.service.pages.byIds(f.id, (body as {ids: string[]}).ids);
    else throw new Error('NON_READING_ROUTE: ' + part);
    return structuredClone(value) as T;
  };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

it('R7-ARCHIVE-003: the actual SQLite page contracts provide all 1205 originals, 270 matches and 241 nested replies without inference', async () => {
  const f = fixture(), cache = new ArchiveSession(f.id, reader(f), () => {});
  try {
    const original: PublicMessage[] = [];
    for (let i = 0; i < 1205; i++) original.push(f.service.humanMessage(f.id, {
      text: (i < 270 ? '検索対象 ' : 'ほかの原文 ') + i,
      replyTo: i > 0 && i <= 240 ? original[i - 1].id : null,
    }, randomUUID()));
    await cache.synchronize(f.service.snapshot(f.id)); expect(cache.messages).toHaveLength(200);
    while (cache.historyCursor) await cache.loadOlder();
    expect(cache.messages.map(m => m.id)).toEqual(original.map(m => m.id));
    await cache.search('検索対象'); while (cache.searchCursor) await cache.search('検索対象', true);
    expect(cache.results.map(m => m.id)).toEqual(original.slice(0, 270).reverse().map(m => m.id));
    await cache.openThread(original[230].id); while (cache.threadCursor) await cache.openThread(cache.threadRoot!, true);
    expect(cache.threadRoot).toBe(original[0].id); expect(cache.thread.map(m => m.id)).toEqual(original.slice(0, 241).map(m => m.id));
    expect(await cache.locate(original[0].id)).toBe(true);
    expect(f.service.session(f.id).call_count).toBe(0); expect(f.store.all('SELECT * FROM runs')).toHaveLength(0);
  } finally { cache.dispose(); f.close(); }
});

it('R7-ARCHIVE-004: a late old page cannot resurrect an edited/deleted body; two views recover edits outside the latest 200', async () => {
  const f = fixture(), a = new ArchiveSession(f.id, reader(f), () => {}), b = new ArchiveSession(f.id, reader(f), () => {});
  try {
    const original = f.say('古い本文'); for (let i = 0; i < 240; i++) f.say('続き ' + i);
    await a.synchronize(f.service.snapshot(f.id)); await b.synchronize(f.service.snapshot(f.id));
    await a.loadOlder(); await b.loadOlder(); const old = structuredClone(original);
    f.service.changeMessage(f.id, original.id, '訂正後', randomUUID());
    await a.synchronize(f.service.snapshot(f.id)); await b.synchronize(f.service.snapshot(f.id));
    expect(a.messages[0].text).toBe('訂正後'); expect(b.messages[0].text).toBe('訂正後');
    const cursor = f.service.snapshot(f.id).cursor;
    f.service.changeMessage(f.id, original.id, null, randomUUID());
    for (const event of f.service.eventsAfter(f.id, cursor)) a.event(event);
    a.event({ revision: old.revision, kind: 'message.created', message: old });
    expect(a.messages[0]).toMatchObject({ deleted: true, text: '' });
    await b.synchronize(f.service.snapshot(f.id)); expect(b.messages[0]).toMatchObject({ deleted: true, text: '' });
    expect(f.service.session(f.id).call_count).toBe(0);
  } finally { a.dispose(); b.dispose(); f.close(); }
});

it('R7-ARCHIVE-005: edit-invalidated search cursors require explicit restart and pending old searches cannot replace a new query', async () => {
  const f = fixture(), normal = reader(f), pending = deferred<Page<PublicMessage>>();
  let delayed = false;
  const read: ArchiveRead = async <T>(path: string, body?: unknown) => delayed && path.includes('q=old') ? pending.promise as Promise<T> : normal<T>(path, body);
  const cache = new ArchiveSession(f.id, read, () => {});
  try {
    const source = f.say('検索対象 最古'); for (let i = 0; i < 59; i++) f.say('検索対象 ' + i); f.say('new unique');
    await cache.synchronize(f.service.snapshot(f.id)); await cache.search('検索対象'); expect(cache.results).toHaveLength(50);
    f.service.changeMessage(f.id, source.id, '別の文章', randomUUID());
    await cache.search('検索対象', true); expect(cache.searchError).toContain('検索結果が更新されました');
    await cache.search('検索対象'); expect(cache.searchError).toBe('');
    delayed = true; const stale = cache.search('old');
    cache.changeQuery(); await cache.search('new'); expect(cache.results).toHaveLength(1);
    pending.resolve({ items: [source], nextCursor: null, highWater: 60 }); await stale;
    expect(cache.results[0].text).toBe('new unique'); expect(cache.searchQuery).toBe('new');
  } finally { cache.dispose(); f.close(); }
});

it('R7-ARCHIVE-006: history errors retain the old cursor and loaded extent; explicit resync repairs an invalid cursor', async () => {
  const f = fixture(), normal = reader(f); let offline = false;
  const read: ArchiveRead = async <T>(path: string, body?: unknown) => { if (offline) throw new Error('SYNTHETIC_OFFLINE'); return normal<T>(path, body); };
  const cache = new ArchiveSession(f.id, read, () => {});
  try {
    for (let i = 0; i < 405; i++) f.say('履歴 ' + i);
    await cache.synchronize(f.service.snapshot(f.id)); const cursor = cache.historyCursor;
    offline = true; await expect(cache.loadOlder()).rejects.toThrow('SYNTHETIC_OFFLINE');
    expect(cache.historyCursor).toBe(cursor); expect(cache.messages).toHaveLength(200); expect(cache.historyBusy).toBe(false);
    offline = false; await cache.loadOlder(); expect(cache.messages).toHaveLength(300);
    cache.historyCursor = 'invalid-cursor'; await expect(cache.loadOlder()).rejects.toThrow();
    await cache.resynchronize(); expect(cache.historyError).toBe('');
    while (cache.historyCursor) await cache.loadOlder();
    expect(cache.messages).toHaveLength(405); expect(new Set(cache.messages.map(m => m.id)).size).toBe(405);
  } finally { cache.dispose(); f.close(); }
});

it('R7-ARCHIVE-007: reconnect bridges more than one snapshot of new input and a disposed view rejects a delayed page', async () => {
  const f = fixture(), normal = reader(f), page = deferred<Page<PublicMessage>>(); let hold = false;
  const read: ArchiveRead = async <T>(path: string, body?: unknown) => hold && path.includes('/history?') ? page.promise as Promise<T> : normal<T>(path, body);
  const cache = new ArchiveSession(f.id, read, () => {});
  try {
    for (let i = 0; i < 250; i++) f.say('先行 ' + i);
    await cache.synchronize(f.service.snapshot(f.id));
    for (let i = 0; i < 300; i++) f.say('切断中 ' + i);
    await cache.synchronize(f.service.snapshot(f.id));
    expect(cache.messages).toHaveLength(500); expect(cache.messages.map(m => m.sequence)).toEqual(Array.from({length: 500}, (_, i) => i + 51));
    const previous = f.service.pages.history(f.id, { cursor: cache.historyCursor }); hold = true;
    const delayed = cache.loadOlder(); cache.dispose(); page.resolve(previous); await delayed;
    expect(cache.messages).toHaveLength(0);
    await cache.synchronize(f.service.snapshot(f.id)); expect(cache.messages).toHaveLength(0);
  } finally { cache.dispose(); f.close(); }
});

it('R7-ARCHIVE-008: a stale thread response cannot contaminate a different selected thread', async () => {
  const f = fixture(), normal = reader(f), page = deferred<Page<PublicMessage> & {rootId: string}>();
  const first = f.say('一つ目'), second = f.say('二つ目');
  const read: ArchiveRead = async <T>(path: string, body?: unknown) => path.includes('/threads/' + first.id) ? page.promise as Promise<T> : normal<T>(path, body);
  const cache = new ArchiveSession(f.id, read, () => {});
  try {
    await cache.synchronize(f.service.snapshot(f.id)); const old = cache.openThread(first.id);
    await cache.openThread(second.id); page.resolve(f.service.pages.thread(f.id, first.id)); await old;
    expect(cache.threadRoot).toBe(second.id); expect(cache.thread.map(m => m.id)).toEqual([second.id]);
    cache.event({ revision: 999, kind: 'message.created', message: { ...first, sessionId: randomUUID() } });
    expect(cache.messages[0].text).toBe('一つ目'); expect(f.service.session(f.id).call_count).toBe(0);
  } finally { cache.dispose(); f.close(); }
});
