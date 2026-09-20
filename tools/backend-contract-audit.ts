import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from '../tests/helpers.js';
import { Store } from '../packages/storage-sqlite/index.js';
import { SessionService } from '../packages/session-service/index.js';
import { loadConfig } from '../packages/config/index.js';
import { SettingsSchema, type ModelProfile, type PublicMessage } from '../packages/contracts/index.js';
import { HttpModel } from '../packages/models/index.js';

// Diagnostic probes for baseline b722028. Expectations describe OBSERVED behavior,
// including defects. A green harness means the observations reproduced, NOT that
// the backend is suitable for production or that real LLM conversations work.
const base = 'b722028da6aaa3cb9ff11192e96aaeeb6848f497';
const results: { id: string; status: string; details: unknown }[] = [];
async function observe(id: string, probe: () => unknown | Promise<unknown>) {
  try { const details = await probe(); results.push({ id, status: 'observed', details }); }
  catch (error) { results.push({ id, status: 'probe_failed', details: error instanceof Error ? error.message : String(error) }); }
}
await observe('message_retention_vs_snapshot_limit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'session-audit-'));
  const f = fixture(3, {}, join(dir, 'history.sqlite'));
  try {
    const first = f.say('共通検索語 最古の発言');
    for (let i = 1; i < 260; i++) f.say('共通検索語 発言 ' + i);
    const count = f.store.get<{n:number}>('SELECT COUNT(*) n FROM messages WHERE session_id=?', f.id)!.n;
    assert.equal(count, 260); assert.equal(f.service.snapshot(f.id).messages.length, 200);
    assert.equal(f.service.searchArchive(f.id, '共通検索語').length, 50);
    assert.equal((f.service.exportSession(f.id).transcript as unknown[]).length, 260);
    assert.equal(f.service.archiveMessage(f.id, first.id).text, first.text);
    const config = f.config, id = f.id; f.close();
    const reopened = new Store(config.dbPath);
    try {
      const service = new SessionService(reopened, config, f.now); service.recover();
      const after = reopened.get<{n:number}>('SELECT COUNT(*) n FROM messages WHERE session_id=?', id)!.n;
      assert.equal(after, 260); assert.equal(service.archiveMessage(id, first.id).text, first.text);
      return { stored: count, afterDatabaseReopen: after, snapshot: service.snapshot(id).messages.length,
        keywordResults: service.searchArchive(id, '共通検索語').length, oldMessageReadableById: true,
        finding: 'Messages survive growth and DB reopen, but normal snapshot/search is capped and provides no history-page cursor.' };
    } finally { reopened.close(); }
  } finally { try { f.close(); } catch {} rmSync(dir, {recursive:true, force:true}); }
});
await observe('private_memory_pruned_after_50', () => {
  const f = fixture(3, {memoryEvery:3});
  try {
    f.start(); let firstText = '';
    for (let batch = 0; batch < 13; batch++) {
      for (let i = 0; i < 3; i++) f.say('記憶の根拠 ' + batch + '-' + i);
      const decide = f.claim()!; assert.equal(decide.kind, 'decide');
      f.finish(decide, {decision:'ABSTAIN', reason:'記憶保存の境界試験'});
      const memory = f.claim()!; assert.equal(memory.kind, 'memory');
      const ref = memory.context.messages.at(-1)!.id;
      const notes = Array.from({length:4}, (_, i) => ({text:'記憶 ' + batch + '-' + i, sourceMessageIds:[ref]}));
      if (!batch) firstText = notes[0].text;
      f.finish(memory, {notes});
    }
    const rows = f.service.workerMemories('worker-0', f.service.agents(f.id)[0].id);
    assert.equal(rows.length, 50); assert.equal(rows.some(row => row.text === firstText), false);
    return { generated:52, retainedInMemoriesTable:rows.length, oldestMemoryDeleted:true,
      finding:'The private-memory store is a 50-item eviction cache, not an archival long-term memory store.' };
  } finally { f.close(); }
});
await observe('review_commits_without_all_intervening_messages', () => {
  const f = fixture(3, {contextMessages:40, memoryEvery:1000});
  try {
    f.say('最初の話題'); f.start(); f.speak(f.claim()!);
    f.finish(f.claim()!, {decision:'DRAFT', text:'古い候補のままです'});
    let omitted: PublicMessage | undefined;
    for (let i = 0; i < 200; i++) {
      const message = f.say(i === 130 ? '見落としてはいけない途中の訂正' : '新着 ' + i);
      if (i === 130) omitted = message;
    }
    const review = f.claim()!; assert.equal(review.kind, 'review');
    const seen = new Set([...review.context.messages, ...review.context.delta].map(m => m.id));
    assert.equal(review.context.delta.length, 100);
    assert.equal(seen.has(omitted!.id), false);
    const transcript = f.service.exportSession(f.id).transcript as PublicMessage[];
    const omittedCount = transcript.filter(m => m.revision > 1 && !seen.has(m.id)).length;
    f.finish(review, {decision:'KEEP'});
    const committed = f.service.commitNext(f.id);
    assert.ok(committed); assert.equal(committed.text, '古い候補のままです');
    return { deltaMessages:review.context.delta.length, recentMessages:review.context.messages.length,
      interveningMessagesOmitted:omittedCount, candidateCommittedDespiteOmission:true,
      finding:'reviewed_revision can advance to the latest revision even though the model never received some intervening messages.' };
  } finally { f.close(); }
});
await observe('retry_stop_reset_by_unrelated_message', () => {
  const f = fixture();
  try {
    f.start();
    for (let i = 0; i < 3; i++) {
      const r = f.claim()!; assert.ok(r);
      f.service.failRun('worker-0', r.workerEpoch, r.id, r.token, 'API_ERROR');
      f.advance(10000);
    }
    assert.equal(f.claim(), null);
    const agent = f.service.agents(f.id)[0];
    const stoppedCount = f.service.agent(agent.id).error_count;
    f.say('障害とは無関係な別参加者の発言');
    const resumedCount = f.service.agent(agent.id).error_count;
    const retried = f.claim(); assert.ok(retried); assert.equal(resumedCount, 0);
    return { failuresBeforeStop:stoppedCount, failuresAfterNewMessage:resumedCount, restartedOnNewMessage:!!retried,
      finding:'The retry limit only holds without new conversation events; no durable provider circuit breaker exists.' };
  } finally { f.close(); }
});
await observe('default_self_wake_cannot_precede_session_deadline', () => {
  const settings = SettingsSchema.parse({}); const f = fixture(3, settings);
  try {
    f.start(); const start = f.service.session(f.id).started_at!;
    const firstWake = Math.min(...f.service.agents(f.id).map(a => a.next_self_at));
    assert.ok(firstWake >= start + settings.maxDurationMs);
    f.advance(settings.maxDurationMs); f.service.tick();
    assert.equal(f.service.session(f.id).stop_reason, 'MAX_DURATION');
    return { maxDurationMs:settings.maxDurationMs, selfWakeRangeMs:[settings.selfWakeMinMs,settings.selfWakeMaxMs],
      stopReason:f.service.session(f.id).stop_reason,
      finding:'With the shipped defaults and no settings changes, the session ends before any autonomous scheduled wake can execute.' };
  } finally { f.close(); }
});
await observe('character_version_is_frozen_per_session', () => {
  const f = fixture();
  try {
    const id = f.service.agents(f.id)[0].id;
    const before = JSON.parse(f.service.agent(id).character_json);
    f.service.putCharacter({...before, version:before.version+1, persona:'更新された人格設定'});
    const old = JSON.parse(f.service.agent(id).character_json);
    assert.equal(old.version, before.version); assert.equal(old.persona, before.persona);
    const next = f.service.createSession(f.input, randomUUID()).id;
    const nextCharacter = JSON.parse(f.service.agents(next)[0].character_json);
    assert.equal(nextCharacter.version, before.version+1);
    return { existingSessionVersion:old.version, newSessionVersion:nextCharacter.version,
      finding:'Existing agents retain their versioned persona snapshot; updating the character definition affects new sessions only.' };
  } finally { f.close(); }
});
await observe('multiple_profiles_and_persona_reach_http_payloads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'session-model-config-'));
  const profiles = [
    {id:'ollama-a',provider:'ollama',model:'audit-a',baseUrl:'https://provider-a.invalid/api/',apiKeyEnv:'AUDIT_KEY_A'},
    {id:'compat-b',provider:'openai',model:'audit-b',baseUrl:'https://provider-b.invalid/v1/',apiKeyEnv:'AUDIT_KEY_B'},
    {id:'compat-c',provider:'openai',model:'audit-c',baseUrl:'https://provider-c.invalid/v1/',apiKeyEnv:'AUDIT_KEY_C'},
  ];
  const path = join(dir, 'config.json'); writeFileSync(path, JSON.stringify({profiles}));
  const env = {APP_CONFIG:path,ALLOW_LIVE_MODELS:'1',ADMIN_TOKEN:'audit-admin-token-not-a-real-secret',
    WORKER_A_TOKEN:'audit-worker-a-not-a-real-secret',WORKER_B_TOKEN:'audit-worker-b-not-a-real-secret',WORKER_C_TOKEN:'audit-worker-c-not-a-real-secret',
    AUDIT_KEY_A:'not-a-key-a',AUDIT_KEY_B:'not-a-key-b',AUDIT_KEY_C:'not-a-key-c'};
  const f = fixture();
  try {
    const config = loadConfig(env); assert.equal(config.profiles.length,3);
    f.config.profiles = config.profiles; f.config.allowLive = true;
    const id = f.service.createSession({...f.input, participants:f.input.participants.map((p,i)=>({...p,profileId:profiles[i].id}))}, randomUUID()).id;
    f.service.lifecycle(id,'start',randomUUID());
    const routes: unknown[] = [];
    for (let i = 0; i < 3; i++) {
      const run = f.service.claim('worker-'+i,f.epochs['worker-'+i])!; assert.equal(run.profile.id,profiles[i].id);
      let capture: {url:string;body:any} | undefined;
      const fetcher = (async (url: any, options: any) => {
        capture = {url:String(url),body:JSON.parse(options.body)};
        const content = JSON.stringify({decision:'ABSTAIN',reason:'Synthetic HTTP fixture, not a live LLM'});
        return new Response(JSON.stringify(run.profile.provider==='ollama'?{message:{content},prompt_eval_count:1,eval_count:1}:{choices:[{message:{content}}],usage:{prompt_tokens:1,completion_tokens:1}}),{status:200});
      }) as typeof fetch;
      const model = new HttpModel(run.profile as ModelProfile,'audit-only-fake-key',fetcher);
      await model.complete(run.kind,run.context,{signal:new AbortController().signal,maxChars:run.contextChars});
      assert.ok(capture!.body.messages[0].content.includes(run.context.self.character.persona));
      assert.ok(capture!.url.endsWith(i===0?'/api/chat':'/v1/chat/completions'));
      routes.push({profile:run.profile.id, endpoint:capture!.url, model:capture!.body.model, personaInSystemPrompt:true});
    }
    return {routes, transport:'injected fake fetch only; no network requests or real model calls',
      finding:'Per-agent profile routing and persona injection exist, but this does not verify live provider compatibility or character behavior.'};
  } finally {f.close();rmSync(dir,{recursive:true,force:true});}
});
mkdirSync('artifacts', {recursive:true});
const report = {auditedApplicationCommit:base,auditCommit:process.env.GITHUB_SHA,node:process.version,liveModelCalls:0,
  interpretation:'Diagnostic harness success is NOT backend acceptance. Read the individual defect findings.',results};
writeFileSync('artifacts/backend-contract-audit.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
if(results.some(result=>result.status==='probe_failed')) process.exitCode=1;
