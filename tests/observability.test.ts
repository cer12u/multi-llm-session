import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {fixture} from './helpers.js';
import {diagnosticExport,diagnosticRun,diagnosticRuns,diagnosticSnapshot,publicTranscript} from '../packages/observability/index.js';
import {ReplayStream,type Header} from '../packages/observability/replay.js';

async function recording(f:ReturnType<typeof fixture>){
  const captured=diagnosticExport(f.service,f.id,{BUILD_SHA:'a'.repeat(40),DIAGNOSTIC_EVIDENCE_MODE:'synthetic'}),lines:string[]=[];
  for await(const line of captured.lines()){expect(f.store.db.inTransaction).toBe(false);lines.push(line);}
  return {header:captured.header,lines,text:lines.join('')};
}
function replay(lines:string[]){const p=new ReplayStream();for(const line of lines)p.push(line.trimEnd());return p.finish();}

it('R10-DIAG-000: public transcript export is an explicit whitelist, separate from private run/state data',()=>{
  const f=fixture();try{
    f.say('public contribution');f.start();const run=f.claim()!;f.finish(run,{decision:'ABSTAIN',reason:'private decision'});
    const value=publicTranscript(f.service,f.id),raw=JSON.stringify(value);
    expect(value.kind).toBe('public-transcript');expect(value.transcript).toEqual(f.service.snapshot(f.id).messages);
    for(const secret of ['persona','profileHash','inputTokens',run.token,f.config.adminToken,...Object.values(f.config.workerTokens)])expect(raw).not.toContain(secret);
    expect(Object.keys(value)).toEqual(['kind','formatVersion','session','transcript']);
    expect(Object.keys(value.session)).toEqual(['id','title','lifecycle','revision','episode']);
  }finally{f.close();}
});

it('R10-DIAG-001: actual state, memory, candidate, edit, pause and restart transitions replay to the independently captured projection without model regeneration',async()=>{
  const f=fixture(3,{memoryEvery:3});try{
    const original=f.say('original evidence');f.say('second');f.say('third');f.start();
    const run=f.claim()!,self=run.context.self;
    f.finish(run,{action:{decision:'ABSTAIN',reason:'keep pending interest'},statePatch:{agentId:self.id,sessionId:f.id,expectedVersion:self.privateState!.version,observationId:run.context.observation!.id,
      upsert:[{id:'kept',kind:'interest',text:'PRIVATE_OWNER_INTEREST',evidence:[{kind:'message',id:original.id,version:original.revision}],resume:null}],remove:[]}});
    const memory=f.claim()!;expect(memory.kind).toBe('memory');f.finish(memory,{notes:[{text:'private retained original',sourceMessageIds:[original.id]}]});
    f.say('new question');f.speak(f.claim()!);f.finish(f.claim()!,{decision:'DRAFT',text:'public answer'});expect(f.service.commitNext(f.id)?.text).toBe('public answer');
    f.service.changeMessage(f.id,original.id,'corrected evidence',randomUUID());f.service.lifecycle(f.id,'pause',randomUUID());f.service.recover();
    const before=f.service.session(f.id).call_count,expected=diagnosticSnapshot(f.store,f.id),{header,lines,text}=await recording(f),result=replay(lines);
    expect(result.state).toEqual(expected);expect(result.transcript).toEqual(publicTranscript(f.service,f.id).transcript);
    expect(result.header.stateRows).toBe(expected.reduce((n,t)=>n+t.rows.length,0));expect(header.baselineRecords).toBe(0);
    expect(result.header.manifest).toMatchObject({exporterCommit:'a'.repeat(40),seed:null,executionCommits:null,declaredEvidenceMode:'synthetic',mode:'mock',liveModelVerified:false});
    expect(text).toContain('PRIVATE_OWNER_INTEREST');for(const token of [run.token,f.config.adminToken,...Object.values(f.config.workerTokens)])expect(text).not.toContain(token);
    expect(f.service.session(f.id).call_count).toBe(before);
    const detail=diagnosticRun(f.service,f.id,run.id);expect(detail.observation).toEqual(run.context.observation);
    expect(detail.stateChanges).toHaveLength(1);expect(JSON.stringify(detail.stateChanges)).toContain('PRIVATE_OWNER_INTEREST');
    expect(detail.traces.some(t=>t.code==='ABSTAIN')).toBe(true);expect(JSON.stringify(detail.contextVersions)).toContain('original evidence');
    expect(JSON.stringify(detail.contextVersions)).not.toContain('corrected evidence');
    expect(diagnosticRun(f.service,f.id,memory.id).memoryChanges).toHaveLength(1);
  }finally{f.close();}
});

it('R10-DIAG-002: rollback and idempotent duplicate results do not invent journal transitions; counter updates are compact',async()=>{
  const f=fixture();try{
    f.say('source');f.start();const run=f.claim()!,output={decision:'ABSTAIN',reason:'quiet'};f.finish(run,output);
    const journal=f.store.all('SELECT * FROM diagnostic_journal');f.service.completeRun('worker-0',run.workerEpoch,run.id,run.token,output);
    expect(f.store.all('SELECT * FROM diagnostic_journal')).toEqual(journal);
    expect(()=>f.store.tx(()=>{f.store.run('UPDATE agent_instances SET due_at=123 WHERE id=?',run.context.self.id);throw new Error('rollback');})).toThrow('rollback');
    expect(f.store.all('SELECT * FROM diagnostic_journal')).toEqual(journal);
    f.store.run('UPDATE agent_instances SET due_at=124 WHERE id=?',run.context.self.id);
    const last=f.store.get<{before_json:string;after_json:string}>('SELECT before_json,after_json FROM diagnostic_journal ORDER BY seq DESC LIMIT 1')!;
    expect(Object.keys(JSON.parse(last.after_json))).toEqual(['id','due_at']);expect(last.before_json).not.toContain('character_json');
    expect(replay((await recording(f)).lines).state).toEqual(diagnosticSnapshot(f.store,f.id));
  }finally{f.close();}
});

it('R10-DIAG-003: consistent export high-water excludes later input and never holds a transaction while yielding',async()=>{
  const f=fixture();try{
    f.say('included');const expected=diagnosticSnapshot(f.store,f.id),captured=diagnosticExport(f.service,f.id);
    const stream=captured.lines(),first=await stream.next();expect(f.store.db.inTransaction).toBe(false);
    f.say('appended while reading');const lines=[first.value!];for await(const line of stream){expect(f.store.db.inTransaction).toBe(false);lines.push(line);}
    const result=replay(lines);expect(result.state).toEqual(expected);expect(result.transcript.map(m=>m.text)).toEqual(['included']);
    expect(publicTranscript(f.service,f.id).transcript).toHaveLength(2);expect(f.service.session(f.id).call_count).toBe(0);
  }finally{f.close();}
});

it('R10-DIAG-004: corrupted, truncated, reordered, wrong-session and missing transition streams fail closed',async()=>{
  const f=fixture();try{
    f.say('one');f.say('two');const {lines}=await recording(f);
    expect(()=>replay(lines.slice(0,-1))).toThrow('REPLAY_FOOTER_REQUIRED');
    expect(()=>replay([...lines,lines.at(-1)!])).toThrow('REPLAY_TRAILING_DATA');
    const wrong=[...lines],frame=JSON.parse(wrong[1]);frame.sessionId=randomUUID();wrong[1]=JSON.stringify(frame)+'\n';expect(()=>replay(wrong)).toThrow('REPLAY_SEQUENCE_INVALID');
    const reordered=[...lines];[reordered[1],reordered[2]]=[reordered[2],reordered[1]];expect(()=>replay(reordered)).toThrow('REPLAY_SEQUENCE_INVALID');
    const changed=[...lines],header=JSON.parse(changed[0]) as Header;header.manifest.exporterCommit='tampered';changed[0]=JSON.stringify(header)+'\n';expect(()=>replay(changed)).toThrow('REPLAY_DIGEST_MISMATCH');
    const forged=[...lines],row=JSON.parse(forged[1]);row.command='execute arbitrary content';forged[1]=JSON.stringify(row)+'\n';expect(()=>replay(forged)).toThrow('REPLAY_SEQUENCE_INVALID');
    // Missing persisted audit data cannot pass simply by recomputing the stream checksum.
    f.store.run("DELETE FROM diagnostic_journal WHERE table_name='messages' AND kind='INSERT' AND seq=(SELECT MIN(seq) FROM diagnostic_journal WHERE table_name='messages')");
    const incomplete=await recording(f);expect(()=>replay(incomplete.lines)).toThrow('REPLAY_STATE_MISMATCH');
    expect(f.service.session(f.id).call_count).toBe(0);
  }finally{f.close();}
});

it('R10-DIAG-005: list pages and exact run inspection cannot cross session or reveal RPC capability tokens',()=>{
  const f=fixture();try{
    const other=f.service.createSession(f.input,randomUUID()).id;f.start();
    for(let i=0;i<4;i++){f.say('topic '+i);f.finish(f.claim()!,{decision:'ABSTAIN',reason:'quiet'});}
    const first=diagnosticRuns(f.service,f.id,{limit:2}),next=diagnosticRuns(f.service,f.id,{limit:2,before:first.nextBefore!});
    expect(first.items).toHaveLength(2);expect(next.items).toHaveLength(2);expect(new Set([...first.items,...next.items].map(r=>r.id)).size).toBe(4);
    expect(()=>diagnosticRun(f.service,other,first.items[0].id)).toThrow('RUN_NOT_FOUND');
    expect(JSON.stringify(diagnosticRun(f.service,f.id,first.items[0].id))).not.toContain('"token"');
  }finally{f.close();}
});
