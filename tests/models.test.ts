import { afterEach,describe,expect,it } from 'vitest';
import { HttpModel,MockModel,ScriptedModel,parseOutput } from '../packages/models/index.js';
import { ModelProfileSchema,type Context } from '../packages/contracts/index.js';
import { fixture } from './helpers.js';
import { parseFeed } from '../packages/sources/index.js';
const cleanup:(()=>void)[]=[];afterEach(()=>cleanup.splice(0).forEach(f=>f()));
function context():Context{const f=fixture();cleanup.push(f.close);f.start();return f.claim()!.context;}

describe('model adapters and untrusted source input',()=>{
  it('validates strict decision schemas including fenced JSON and wrapped output',()=>{
    expect(parseOutput('decide','```json\n{"decision":"ABSTAIN","reason":"listen"}\n```')).toEqual({decision:'ABSTAIN',reason:'listen'});
    expect(parseOutput('review','{"result":{"decision":"KEEP"}}',true)).toEqual({decision:'KEEP'});
    expect(()=>parseOutput('decide','{"decision":"ABSTAIN","reason":"x","sender":"other"}')).toThrow('FORMAT_ERROR');
  });
  it('uses Ollama non-streaming chat, explicit format options and reported usage',async()=>{
    const profile=ModelProfileSchema.parse({id:'test',provider:'ollama',model:'test-model',baseUrl:'https://model.example/api',jsonMode:'json'});
    let request:RequestInit|undefined,url='';
    const fetcher=(async(input:URL|RequestInfo,init?:RequestInit)=>{url=String(input);request=init;return new Response(JSON.stringify({message:{content:'{"decision":"ABSTAIN","reason":"listen"}'},prompt_eval_count:123,eval_count:10}),{status:200});}) as typeof fetch;
    const out=await new HttpModel(profile,'key',fetcher).complete('decide',context(),{signal:new AbortController().signal,maxChars:24000});
    expect(url).toBe('https://model.example/api/chat');expect(JSON.parse(request!.body as string).stream).toBe(false);expect(JSON.parse(request!.body as string).format).toBe('json');expect(out.usage).toEqual({inputTokens:123,outputTokens:10});
  });
  it('uses an OpenAI-compatible root object for strict structured output',async()=>{
    const profile=ModelProfileSchema.parse({id:'test',provider:'openai',model:'test',baseUrl:'https://model.example/v1',jsonMode:'schema'});
    let body:Record<string,unknown>={};
    const fetcher=(async(_input:URL|RequestInfo,init?:RequestInit)=>{body=JSON.parse(init!.body as string);return new Response(JSON.stringify({choices:[{message:{content:'{"result":{"decision":"KEEP"}}'}}]}));}) as typeof fetch;
    const out=await new HttpModel(profile,'key',fetcher).complete('review',context(),{signal:new AbortController().signal,maxChars:24000});
    expect(body).toHaveProperty('response_format.json_schema.schema.type','object');expect(out.usage.inputTokens).toBeNull();expect(parseOutput('review',out.text,true)).toEqual({decision:'KEEP'});
  });
  it('classifies 429 without retaining sensitive provider response text',async()=>{
    const profile=ModelProfileSchema.parse({id:'test',provider:'openai',model:'test',baseUrl:'https://example.com/v1'});
    const fetcher=(async()=>new Response('secret error prompt',{status:429})) as typeof fetch;
    await expect(new HttpModel(profile,'key',fetcher).complete('decide',context(),{signal:new AbortController().signal,maxChars:24000})).rejects.toThrow('RATE_LIMIT');
  });
  it('marks mock output visibly and does not claim token usage',async()=>{
    const model=new MockModel(),c=context();const out=await model.complete('draft',c,{signal:new AbortController().signal,maxChars:24000});
    expect(out.text).toContain('模擬応答');expect(out.usage.outputTokens).toBeNull();
  });
  it('supports scripted invalid outputs for deterministic repair tests',async()=>{
    const model=new ScriptedModel(['not JSON','{"decision":"ABSTAIN","reason":"listen"}']);
    expect((await model.complete('decide',context())).text).toBe('not JSON');
    expect(parseOutput('decide',(await model.complete('decide',context())).text)).toHaveProperty('decision','ABSTAIN');
  });
  it('parses RSS and Atom metadata without inventing publication dates',()=>{
    const rss=parseFeed('<rss><channel><item><guid>one</guid><title>題材</title><description>本文</description><pubDate>invalid</pubDate></item></channel></rss>');
    expect(rss[0]).toMatchObject({title:'題材',text:'本文',publishedAt:null});
    const atom=parseFeed('<feed><entry><id>two</id><title>題材</title><summary>本文</summary><link href="https://example.com/a"/><updated>2026-01-02T00:00:00Z</updated></entry></feed>');
    expect(atom[0].url).toBe('https://example.com/a');expect(atom[0].publishedAt).toBe('2026-01-02T00:00:00.000Z');
  });
  it('rejects entity declarations and oversized feeds',()=>{
    expect(()=>parseFeed('<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss/>')).toThrow('UNSAFE_FEED');
    expect(()=>parseFeed('x'.repeat(1048577))).toThrow('UNSAFE_FEED');
  });
});
