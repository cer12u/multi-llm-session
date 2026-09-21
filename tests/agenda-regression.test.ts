import {expect,it} from 'vitest';
import {fixture} from './helpers.js';

it('R3-AGENDA-001: a private timed intention resumes the owner once without forcing a public message',()=>{
  const f=fixture(3,{idleMs:60000,memoryEvery:1000,selfWakeMinMs:60000,selfWakeMaxMs:60000});
  try{
    f.say('後で自分の疑問を再確認する');f.start();const r=f.claim()!;
    const state=r.context.self.privateState!;
    f.finish(r,{action:{decision:'ABSTAIN',reason:'今は聞く'},statePatch:{agentId:state.agentId,sessionId:f.id,
      expectedVersion:state.version,observationId:r.context.observation!.id,
      upsert:[{id:'later-question',kind:'question',text:'本人が後で確認したい疑問',evidence:[],
        resume:{kind:'time',agentId:null,topic:null,notBefore:f.now()+30000}}],remove:[]}});
    expect(f.claim()).toBeNull();f.advance(30000);
    const awakened=f.claim();expect(awakened).not.toBeNull();
    expect(awakened!.kind).toBe('decide');
    expect(awakened!.context.trigger).toBe('AGENDA');
    expect(awakened!.context).toHaveProperty('agenda.triggered');
    expect(f.service.session(f.id).bot_count).toBe(0);
    f.finish(awakened!,{decision:'ABSTAIN',reason:'再確認して今は話さない'});
    expect(f.claim()).toBeNull();expect(f.service.session(f.id).bot_count).toBe(0);
  }finally{f.close();}
});
