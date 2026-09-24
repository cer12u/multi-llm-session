import {expect,it} from 'vitest';
import {fixture} from './helpers.js';
import {ModelProfileSchema} from '../packages/contracts/index.js';
import {HttpModel} from '../packages/models/index.js';

it.each(['openai','ollama'] as const)('R8-PROFILE-004: %s sends declared JSON/token/temperature capabilities and keeps absent usage unknown',async provider=>{
  const f=fixture();
  try{
    f.start();const context=f.claim()!.context;
    for(const jsonMode of ['none','json','schema'] as const){
      const profile=ModelProfileSchema.parse({id:'declared',provider,model:'fixture-model',baseUrl:'https://fixture.invalid/api',authRequired:false,jsonMode,maxOutputTokens:2048,capabilities:{jsonModes:[jsonMode],outputTokenParameter:provider==='ollama'?'num_predict':'max_completion_tokens',temperatureSupported:false,usage:'unavailable'}});
      let supplied:Record<string,unknown>={};
      const fetcher:typeof fetch=async(_url,init)=>{supplied=JSON.parse(String(init?.body));return new Response(JSON.stringify(provider==='ollama'?{done:true,message:{content:'{}'}}:{choices:[{finish_reason:'stop',message:{content:'{}'}}]}));};
      const result=await new HttpModel(profile,undefined,fetcher).complete('decide',context,{signal:new AbortController().signal,maxChars:24000});
      expect(result.usage).toEqual({inputTokens:null,outputTokens:null});expect(supplied.model).toBe('fixture-model');
      if(provider==='ollama'){
        expect(supplied.options).toEqual({num_predict:2048});
        if(jsonMode==='none')expect(supplied).not.toHaveProperty('format');else if(jsonMode==='json')expect(supplied.format).toBe('json');else expect(supplied).toHaveProperty('format.type','object');
      }else{
        expect(supplied.max_completion_tokens).toBe(2048);expect(supplied).not.toHaveProperty('max_tokens');expect(supplied).not.toHaveProperty('temperature');
        if(jsonMode==='none')expect(supplied).not.toHaveProperty('response_format');else expect(supplied).toHaveProperty('response_format.type',jsonMode==='json'?'json_object':'json_schema');
      }
    }
  }finally{f.close();}
});

it.each([
  ['EMPTY_RESPONSE',{choices:[],usage:{prompt_tokens:8,completion_tokens:0}}],
  ['EMPTY_RESPONSE',{choices:[{message:{content:'   '}}],usage:{prompt_tokens:8,completion_tokens:0}}],
  ['OUTPUT_TRUNCATED',{choices:[{finish_reason:'length',message:{content:'partial'}}],usage:{prompt_tokens:8,completion_tokens:128}}],
  ['RESPONSE_REFUSED',{choices:[{finish_reason:'content_filter',message:{content:null}}],usage:{prompt_tokens:8,completion_tokens:0}}],
  ['OUTPUT_TOO_LARGE',{choices:[{message:{content:'x'.repeat(65537)}}],usage:{prompt_tokens:8,completion_tokens:1000}}],
] as const)('R8-PROFILE-005: %s is explicit and does not drop reported usage',async(code,body)=>{
  const f=fixture();
  try{
    f.start();const profile=ModelProfileSchema.parse({id:'test',provider:'openai',model:'fixture',baseUrl:'https://fixture.invalid/v1',authRequired:false});
    const model=new HttpModel(profile,undefined,async()=>new Response(JSON.stringify(body)));
    await expect(model.complete('decide',f.claim()!.context,{signal:new AbortController().signal,maxChars:24000})).rejects.toMatchObject({code,usage:{inputTokens:8}});
  }finally{f.close();}
});

it('R8-PROFILE-006: failed transport is unknown delivery; oversized/malformed response is rejected without storing provider text',async()=>{
  const f=fixture();
  try{
    f.start();const context=f.claim()!.context,profile=ModelProfileSchema.parse({id:'test',provider:'openai',model:'fixture',baseUrl:'https://fixture.invalid/v1',authRequired:false});
    for(const [fetcher,code] of [
      [async()=>{throw new Error('do-not-return-sensitive-transport-details');},'DELIVERY_UNKNOWN'],
      [async()=>new Response('x'.repeat(1048577)),'OUTPUT_TOO_LARGE'],
      [async()=>new Response('{invalid private data'),'API_ERROR'],
      [async()=>new Response('private authentication error',{status:401}),'AUTH_ERROR'],
      [async()=>new Response('private throttling details',{status:429,headers:{'retry-after':'2'}}),'RATE_LIMIT'],
    ] as const){
      await expect(new HttpModel(profile,undefined,fetcher).complete('decide',context,{signal:new AbortController().signal,maxChars:24000})).rejects.toMatchObject({code,message:code});
    }
  }finally{f.close();}
});
