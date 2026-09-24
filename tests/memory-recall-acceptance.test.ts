import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {fixture} from './helpers.js';
import {LocalMemoryRetriever,MeaningMemoryRetriever,recallRequest,type RecallRequest} from '../packages/session-service/recall.js';
import type {MemoryMeaning,Context} from '../packages/contracts/index.js';

it('R5-RECALL-020: old paraphrase, person and validity-time retrieval is measured separately from any generation',()=>{
  const f=fixture();
  try{
    const originals=Array.from({length:245},(_,i)=>f.say('保持する原文 '+i));
    const [a,b,c]=f.service.agents(f.id);let sequence=0;
    const day=Date.parse('2026-09-21T00:00:00Z');
    function add(owner:string,text:string,meaning:MemoryMeaning|null,sourceIndex:number,status='ACTIVE'):string{
      const id=randomUUID(),source=originals[sourceIndex];sequence++;
      f.store.run('INSERT INTO memories(id,agent_id,text,sources_json,created_at,sequence) VALUES(?,?,?,?,?,?)',id,owner,text,JSON.stringify([source.id]),f.now(),sequence);
      f.store.run('INSERT INTO memory_metadata(memory_id,status,meaning_json,evidence_json) VALUES(?,?,?,?)',id,status,meaning?JSON.stringify(meaning):null,JSON.stringify([{kind:'message',id:source.id,version:source.revision}]));
      f.store.run('UPDATE agent_instances SET memory_seq=? WHERE id=?',sequence,owner);return id;
    }
    const meaning=(changes:Partial<MemoryMeaning>):MemoryMeaning=>({subjectId:null,topic:'合成試験',key:'識別する項目',value:'値',epistemic:'uncertain',validFrom:null,validTo:null,aliases:[],...changes});
    const paraphrase=add(a.id,'対話の約束を保持する',meaning({key:'打合せ予定',value:'来週',aliases:['面談','アポイントメント']}),0);
    const person=add(a.id,'締切は木曜日',meaning({subjectId:b.id,key:'締切',value:'木曜日'}),1);
    add(a.id,'締切は金曜日',meaning({subjectId:c.id,key:'締切',value:'金曜日'}),2);
    const historic=add(a.id,'過去の旅程',meaning({key:'出張先',value:'京都',aliases:['旅先'],validFrom:day-86400000,validTo:day}),3);
    const current=add(a.id,'現在の旅程',meaning({key:'出張先',value:'札幌',aliases:['旅先'],validFrom:day,validTo:day+86400000}),4);
    const superseded=add(a.id,'置換された空想項目',meaning({aliases:['無効専用照会']}),5,'SUPERSEDED');
    const invalid=add(a.id,'失効した空想項目',meaning({aliases:['無効専用照会']}),6,'INVALID');
    const deleted=add(a.id,'削除された根拠',meaning({aliases:['削除専用照会']}),7);
    f.service.changeMessage(f.id,originals[7].id,null,randomUUID());
    const foreign=add(b.id,'他者だけの面談の約束',meaning({aliases:['面談','アポイントメント']}),8);
    for(let i=0;i<30;i++)add(a.id,'関係のない献立 '+i,meaning({key:'料理'+i,value:'果物'}),220+i%20);
    const request=(text:string,extra:Partial<RecallRequest>={}):RecallRequest=>({sessionId:f.id,agentId:a.id,text,evidenceIds:[],limit:1,at:day+1000,...extra});
    const cases:{name:string;request:RecallRequest;expected:string[]}[]=[
      {name:'paraphrase-outside-recent12',request:request('アポイントメント'),expected:[paraphrase]},
      {name:'person-reference',request:request('締切',{subjectIds:[b.id]}),expected:[person]},
      {name:'historic-date',request:request('旅先',{at:day-1000}),expected:[historic]},
      {name:'current-date',request:request('旅先'),expected:[current]},
      {name:'invalid-and-superseded',request:request('無効専用照会'),expected:[]},
      {name:'deleted-original',request:request('削除専用照会'),expected:[]},
      {name:'missing-information',request:request('QZXUNMATCHED790'),expected:[]},
    ];
    const retrievers=[{name:'lexical-baseline',value:new LocalMemoryRetriever(f.store)},{name:'meaning-alias-person-time',value:new MeaningMemoryRetriever(f.store)}];
    const measurements=cases.flatMap(item=>retrievers.map(engine=>{
      const start=performance.now(),selected=engine.value.search(item.request),elapsedMs=performance.now()-start,ids=selected.map(x=>x.note.id);
      const correct=ids.filter(id=>item.expected.includes(id)).length;
      const result={name:item.name,algorithm:engine.name,expected:item.expected,retrieved:ids,
        recall:item.expected.length?correct/item.expected.length:null,precision:ids.length?correct/ids.length:null,
        falseRetrievals:ids.filter(id=>!item.expected.includes(id)).length,elapsedMs,additionalModelCalls:0,generationAttempted:false};
      if(engine.name==='meaning-alias-person-time')expect(ids,item.name).toEqual(item.expected);
      expect(ids).not.toContain(superseded);expect(ids).not.toContain(invalid);expect(ids).not.toContain(deleted);expect(ids).not.toContain(foreign);
      for(const row of selected){expect(row.note.provenance?.verified).toBe(false);expect(row.note.provenance?.independentSupport).toBeNull();expect(row.originals.every(m=>!m.deleted&&m.session_id===f.id)).toBe(true);}
      expect(Number.isFinite(elapsedMs)).toBe(true);return result;
    }));
    expect(measurements.find(m=>m.name==='paraphrase-outside-recent12'&&m.algorithm==='lexical-baseline')!.retrieved).toEqual([]);
    expect(new MeaningMemoryRetriever(f.store).search({...request('面談'),sessionId:randomUUID()})).toEqual([]);
    expect(f.service.session(f.id).call_count).toBe(0);
    mkdirSync('artifacts',{recursive:true});writeFileSync('artifacts/memory-retrieval-comparison.json',JSON.stringify({mode:'synthetic-retrieval-only',sourceMessages:245,observations:measurements,liveLLM:false},null,2));
  }finally{f.close();}
});

it('R5-RECALL-021: explicit dates and named participants become retrieval constraints, not fabricated model knowledge',()=>{
  const f=fixture();
  try{
    const [a,b]=f.service.snapshot(f.id).agents,message=f.say(`${b.name}の2026-09-20の予定について`);
    const context={self:{id:a.id,character:f.config.characters[0]},participants:f.service.snapshot(f.id).agents,messages:[message],delta:[],revision:message.revision,trigger:'MESSAGE',historyTruncated:false,memories:[],questions:[],sources:[],candidate:null} as Context;
    const request=recallRequest(context,f.id,a.id,Date.parse('2026-09-21T00:00:00Z'));
    expect(request.at).toBe(Date.parse('2026-09-20T00:00:00Z'));expect(request.subjectIds).toContain(b.id);
    expect(request.agentId).toBe(a.id);expect(request.includeHistorical).toBe(false);
    expect(recallRequest({...context,messages:[{...message,text:'以前の予定の履歴'}]},f.id,a.id).includeHistorical).toBe(true);
  }finally{f.close();}
});
