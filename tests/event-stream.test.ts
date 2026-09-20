import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Snapshot } from '../packages/contracts/index.js';
import { subscribeSession } from '../apps/web/src/event-stream.js';

class TestEventSource {
  static instances: TestEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) { TestEventSource.instances.push(this); }
  close() { this.closed = true; }
}

// These tests only exercise the transport projection, not a domain snapshot validator.
function snapshot(cursor: string): Snapshot {
  return { session: { id: 'test-session' }, cursor } as Snapshot;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const stops: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  TestEventSource.instances = [];
  vi.stubGlobal('EventSource', TestEventSource);
});
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function subscribe(load: () => Promise<Snapshot>) {
  const publish = vi.fn(), status = vi.fn();
  const stop = subscribeSession(load, publish, status);
  stops.push(stop);
  return { publish, status, stop };
}

it('opens a public event stream after acquiring a snapshot and its cursor', async () => {
  const first = snapshot('epoch:7');
  const load = vi.fn().mockResolvedValue(first);
  const { publish, status } = subscribe(load);
  await vi.advanceTimersByTimeAsync(0);
  expect(publish).toHaveBeenCalledWith(first);
  expect(TestEventSource.instances).toHaveLength(1);
  const stream = TestEventSource.instances[0];
  expect(stream.url).toBe('/v1/sessions/test-session/events?cursor=epoch%3A7');
  stream.onopen?.();
  expect(status).toHaveBeenLastCalledWith('接続中');
});

it('recovers a failed or invalid cursor from a new snapshot before reconnecting', async () => {
  const load = vi.fn().mockResolvedValueOnce(snapshot('old:1')).mockResolvedValueOnce(snapshot('new:9'));
  const { publish, status } = subscribe(load);
  await vi.advanceTimersByTimeAsync(0);
  const old = TestEventSource.instances[0];
  old.onerror?.();
  expect(old.closed).toBe(true);
  expect(status).toHaveBeenLastCalledWith('再接続中');
  await vi.advanceTimersByTimeAsync(1000);
  expect(load).toHaveBeenCalledTimes(2);
  expect(publish).toHaveBeenLastCalledWith(snapshot('new:9'));
  expect(TestEventSource.instances[1].url).toContain('new%3A9');
});

it('does not publish a delayed initial snapshot after the session view is disposed', async () => {
  const pending = deferred<Snapshot>();
  const { publish, stop } = subscribe(() => pending.promise);
  stop();
  pending.resolve(snapshot('late:1'));
  await vi.advanceTimersByTimeAsync(0);
  expect(publish).not.toHaveBeenCalled();
  expect(TestEventSource.instances).toHaveLength(0);
});

it('coalesces events without losing a change arriving during a snapshot request', async () => {
  const pending = deferred<Snapshot>();
  const load = vi.fn().mockResolvedValueOnce(snapshot('r:1'))
    .mockImplementationOnce(() => pending.promise).mockResolvedValueOnce(snapshot('r:3'));
  const { publish } = subscribe(load);
  await vi.advanceTimersByTimeAsync(0);
  const stream = TestEventSource.instances[0];
  stream.onmessage?.();
  stream.onmessage?.();
  await vi.advanceTimersByTimeAsync(100);
  expect(load).toHaveBeenCalledTimes(2);
  stream.onmessage?.();
  await vi.advanceTimersByTimeAsync(100);
  pending.resolve(snapshot('r:2'));
  await vi.advanceTimersByTimeAsync(0);
  expect(load).toHaveBeenCalledTimes(3);
  expect(publish).toHaveBeenLastCalledWith(snapshot('r:3'));
});

it('ignores an old in-flight response after a newer connection has recovered', async () => {
  const pending = deferred<Snapshot>();
  const load = vi.fn().mockResolvedValueOnce(snapshot('r:1'))
    .mockImplementationOnce(() => pending.promise).mockResolvedValueOnce(snapshot('r:8'));
  const { publish } = subscribe(load);
  await vi.advanceTimersByTimeAsync(0);
  const old = TestEventSource.instances[0];
  old.onmessage?.();
  await vi.advanceTimersByTimeAsync(100);
  old.onerror?.();
  await vi.advanceTimersByTimeAsync(1000);
  expect(publish).toHaveBeenLastCalledWith(snapshot('r:8'));
  pending.resolve(snapshot('r:2'));
  await vi.advanceTimersByTimeAsync(0);
  expect(publish).toHaveBeenLastCalledWith(snapshot('r:8'));
  expect(publish).not.toHaveBeenCalledWith(snapshot('r:2'));
});
