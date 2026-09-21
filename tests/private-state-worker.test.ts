import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers.js';
import { buildServer } from '../apps/core/server.js';
import { CoreClient, WorkerRuntime } from '../apps/agent-worker/runtime.js';
import { HttpModel, parseOutput, ScriptedModel } from '../packages/models/index.js';
import { ModelProfileSchema, type Context, type StatePatch } from '../packages/contracts/index.js';

function change(context: Context, text: string): StatePatch {
  const source = context.messages[0];
  return { agentId: context.self.id, sessionId: context.self.privateState!.sessionId,
    expectedVersion: context.self.privateState!.version, observationId: context.observation!.id,
    upsert: [{ id: 'private-question', kind: 'question', text,
      evidence: [{ kind: 'message', id: source.id, version: source.revision }], resume: null }], remove: [] };
}

it('R2-STATE-016: three real WorkerRuntime→Core HTTP paths persist different silent states into their actual next model requests', async () => {
  const f = fixture(), app = buildServer(f.service, { timers: false });
  try {
    f.say('後でそれぞれが確認したいことを考えてください。');
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address(); if (!address || typeof address === 'string') throw new Error('No test port');
    const captured: Context[][] = [[], [], []];
    const profile = ModelProfileSchema.parse({ id: 'synthetic', provider: 'openai', model: 'synthetic', baseUrl: 'https://synthetic.invalid/v1', authRequired: false });
    const workers = captured.map((inputs, index) => {
      // Provider HTTP transport is synthetic; the body below is what HttpModel actually sends.
      const fetcher: typeof fetch = async (_input, init) => {
        const request = JSON.parse(String(init!.body)) as { messages: { role: string; content: string }[] };
        const context = JSON.parse(request.messages.find(m => m.role === 'user')!.content) as Context;
        inputs.push(context);
        const result = inputs.length === 1
          ? { action: { decision: 'ABSTAIN', reason: '本人の疑問を残して聞く' }, statePatch: change(context, `個体${index}だけの私有疑問`) }
          : { action: { decision: 'ABSTAIN', reason: '保持した疑問を次の入力で確認' }, statePatch: null };
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
      };
      return new WorkerRuntime(new CoreClient(`http://127.0.0.1:${address.port}`, f.config.workerTokens[`worker-${index}`]), {},
        () => new HttpModel(profile, undefined, fetcher));
    });
    await Promise.all(workers.map(w => w.register())); f.start();
    await Promise.all(workers.map(w => w.once()));
    expect(f.service.session(f.id).bot_count).toBe(0);
    expect(f.service.agents(f.id).every(a => a.error_count === 0)).toBe(true);
    f.say('それぞれの疑問を忘れずに、続きを聞いてください。');
    await Promise.all(workers.map(w => w.once()));
    for (let i = 0; i < captured.length; i++) {
      expect(captured[i]).toHaveLength(2);
      expect(captured[i][0].self.privateState!.entries).toHaveLength(0);
      expect(captured[i][1].self.privateState!.version).toBe(1);
      expect(captured[i][1].self.privateState!.entries[0].text).toBe(`個体${i}だけの私有疑問`);
      for (let j = 0; j < captured.length; j++) if (j !== i) expect(JSON.stringify(captured[i][1])).not.toContain(`個体${j}だけの私有疑問`);
    }
    expect(f.service.session(f.id).call_count).toBe(6);
    expect(f.store.all('SELECT * FROM agent_state_updates')).toHaveLength(6);
    expect(JSON.stringify(f.service.exportSession(f.id))).not.toContain('だけの私有疑問');
    const viewer = await app.inject({ method: 'GET', url: `/v1/sessions/${f.id}/snapshot`, headers: { authorization: 'Bearer ' + f.config.viewerToken } });
    expect(viewer.statusCode).toBe(200); expect(viewer.body).not.toContain('privateState'); expect(viewer.body).not.toContain('だけの私有疑問');
  } finally { await app.close(); f.close(); }
}, 20000);

it('R2-STATE-017: archive LOOKUP refreshes the observation binding without losing state or permitting unrequested originals', async () => {
  const f = fixture(3, { contextMessages: 5 }), app = buildServer(f.service, { timers: false });
  try {
    const original = f.say('原文の予定は火曜日'); for (let i = 0; i < 9; i++) f.say('最近の会話 ' + i);
    let firstObservation = '';
    const model = new ScriptedModel([
      context => { firstObservation = context.observation!.id; return JSON.stringify({ decision: 'LOOKUP', requests: [{ kind: 'message', query: original.id, cursor: null }] }); },
      context => {
        expect(context.observation!.id).not.toBe(firstObservation);
        expect(context.observation!.messages).toContainEqual({ kind: 'message', id: original.id, version: original.revision });
        const patch = change(context, '古い予定の根拠を確認した本人の疑問');
        patch.upsert[0].evidence = [{ kind: 'message', id: original.id, version: original.revision }];
        return JSON.stringify({ action: { decision: 'ABSTAIN', reason: '原文を確認した' }, statePatch: patch });
      },
    ]);
    await app.listen({ host: '127.0.0.1', port: 0 }); const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('No port');
    const worker = new WorkerRuntime(new CoreClient(`http://127.0.0.1:${address.port}`, f.config.workerTokens['worker-0']), {}, () => model);
    await worker.register(); f.start(); await worker.once();
    expect(f.service.agents(f.id)[0].error_count).toBe(0);
    const saved = f.store.get<{ version: number; entries_json: string }>('SELECT * FROM agent_private_states WHERE agent_id=?', f.service.agents(f.id)[0].id)!;
    expect(saved.version).toBe(1); expect(saved.entries_json).toContain(original.id);
    expect(f.service.session(f.id).call_count).toBe(2);
  } finally { await app.close(); f.close(); }
}, 20000);

it('R2-STATE-018: state-aware oversized input fails before transport instead of acknowledging silently discarded evidence', async () => {
  const f = fixture();
  try {
    f.say('根拠'); f.start(); const context = f.claim()!.context;
    context.memories = [{ id: randomUUID(), text: 'x'.repeat(30000), sourceMessageIds: [context.messages[0].id] }];
    let called = false;
    const transport: typeof fetch = async () => { called = true; throw new Error('must not call'); };
    const profile = ModelProfileSchema.parse({ id: 'synthetic', provider: 'openai', model: 'synthetic', baseUrl: 'https://synthetic.invalid/v1', authRequired: false });
    await expect(new HttpModel(profile, undefined, transport).complete('decide', context, { signal: new AbortController().signal, maxChars: 24000 })).rejects.toThrow('CONTEXT_LIMIT');
    expect(called).toBe(false);
    expect(context.memories).toHaveLength(1); expect(context.memories[0].text.length).toBe(30000);
  } finally { f.close(); }
});

it('R2-STATE-019: stateful structured outputs and old action-only fixtures share the validated wire path', () => {
  const f = fixture();
  try {
    f.say(); f.start(); const context = f.claim()!.context;
    const result = { action: { decision: 'ABSTAIN', reason: '聞く' }, statePatch: change(context, '次回へ残す疑問') };
    expect(parseOutput('decide', JSON.stringify({ result }), true)).toEqual(result);
    expect(parseOutput('decide', JSON.stringify(result))).toEqual(result);
    expect(parseOutput('decide', '{"decision":"ABSTAIN","reason":"旧形式"}')).toEqual({ decision: 'ABSTAIN', reason: '旧形式' });
  } finally { f.close(); }
});
