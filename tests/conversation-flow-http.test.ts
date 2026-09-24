import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers.js';
import { buildServer } from '../apps/core/server.js';
import { CoreClient, WorkerRuntime } from '../apps/agent-worker/runtime.js';
import { modelRequest } from '../packages/models/index.js';
import type { Context } from '../packages/contracts/index.js';

it('R6-FLOW-007: one topic starts three independent HTTP workers; purpose feedback permits quiet and source-driven reconsideration without a viewer', async () => {
  const f = fixture(3, { memoryEvery: 1000, memoryFlushMs: 86400000, selfWakeEnabled: false }), app = buildServer(f.service, { timers: false });
  const captured: Context[][] = [[], [], []];
  try {
    await app.listen({ host: '127.0.0.1', port: 0 }); const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('NO_SYNTHETIC_CORE_PORT');
    const base = `http://127.0.0.1:${address.port}`; f.config.publicOrigin = base;
    const workers = f.service.agents(f.id).map((agent, index) => new WorkerRuntime(new CoreClient(base, f.config.workerTokens[agent.slot]), {}, run => ({
      complete: async (kind, context) => {
        captured[index].push(structuredClone(context));
        const request = modelRequest(run.profile, kind, context, { maxChars: run.contextChars });
        expect(JSON.parse((request.messages as { role: string; content: string }[]).find(m => m.role === 'user')!.content)).toEqual(context);
        const purpose = 'synthetic-purpose-' + index + (context.sources.some(s => s.title === '第二の資料') ? '-source' : '-topic');
        let action: unknown, statePatch: unknown;
        if (kind === 'memory') action = { notes: [] };
        else if (kind === 'observe') action = { decision: 'ABSTAIN', reason: 'listen without forcing publication' };
        else if (kind === 'decide') {
          if (context.conversation!.recentPurposes.some(p => p.purpose === purpose)) {
            action = { decision: 'ABSTAIN', reason: 'this synthetic purpose has already been expressed' };
            if (context.delivery!.complete) statePatch = { agentId: agent.id, sessionId: f.id, expectedVersion: context.self.privateState!.version,
              observationId: context.observation!.id, upsert: [{ id: 'own-disposition', kind: 'intention', text: 'purpose is satisfied in this fixture',
                evidence: [], resume: null, participation: { code: 'SATISFIED', throughInput: context.delivery!.throughInput } }], remove: [] };
          } else action = { decision: 'SPEAK', intent: { act: ['comment', 'agreement', 'joke'][index], intent: purpose, replyTo: null, addressedTo: [] } };
        } else if (kind === 'draft') action = { decision: 'DRAFT', text: '独立した本人の合成発言 ' + purpose };
        else action = context.coverage!.complete ? { decision: 'KEEP' } : { decision: 'REWRITE', text: context.candidate!.text, intent: context.candidate!.intent };
        return { text: JSON.stringify(statePatch ? { action, statePatch } : action), usage: { inputTokens: null, outputTokens: null } };
      },
    })));
    await Promise.all(workers.map(w => w.register())); f.say('一回だけ投入する題材'); f.start();
    async function settle() {
      for (let i = 0; i < 80; i++) {
        const worked = await Promise.all(workers.map(w => w.once())); f.service.tick();
        if (worked.every(value => !value) && f.service.session(f.id).activity === 'QUIET') return;
      }
      throw new Error('SYNTHETIC_CONVERSATION_DID_NOT_QUIESCE');
    }
    await settle();
    expect(f.service.snapshot(f.id).messages.filter(m => m.authorId === null)).toHaveLength(1);
    const first = f.service.session(f.id).bot_count; expect(first).toBe(3);
    expect(f.service.agents(f.id).every(a => a.error_count === 0)).toBe(true);
    const calls = f.service.session(f.id).call_count; for (let i = 0; i < 10; i++) f.service.tick();
    expect(f.service.session(f.id).call_count).toBe(calls);
    f.service.injectSource(f.id, { title: '第二の資料', text: '新しい情報を各本人が受けて判断する' }, randomUUID()); await settle();
    expect(f.service.session(f.id).bot_count).toBe(first + 3);
    expect(f.service.snapshot(f.id).messages.filter(m => m.authorId === null)).toHaveLength(1);
    expect(captured.every(values => values.some(c => c.conversation?.recentPurposes.length))).toBe(true);
    expect(f.service.agents(f.id).every(a => a.error_count === 0)).toBe(true);
    // These exact counts are fixture branch coverage, never a natural-conversation quality score.
  } finally { await app.close(); f.close(); }
}, 30000);
