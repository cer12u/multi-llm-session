import {expect,it} from 'vitest';
import {fixture} from './helpers.js';
import {buildServer} from '../apps/core/server.js';
import {ConfiguredFeedSource,parseFeed} from '../packages/sources/index.js';
import {ModelProfileSchema} from '../packages/contracts/index.js';
import {credential} from '../packages/config/credentials.js';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

it('R10-SEC-020: configured source transport never follows redirects and rejects a substituted final URL and oversized content',async()=>{
  const url='https://feed.example.invalid/rss',signal=new AbortController().signal;
  let options:RequestInit|undefined;
  const redirected=new Response('<rss><channel/></rss>');Object.defineProperty(redirected,'url',{value:'http://127.0.0.1/private'});
  await expect(new ConfiguredFeedSource(url,async(_url,init)=>{options=init;return redirected;}).acquire(signal)).rejects.toThrow('FEED_HTTP_ERROR');
  expect(options?.redirect).toBe('error');expect(options?.headers).toBeUndefined();
  await expect(new ConfiguredFeedSource(url,async()=>new Response('x'.repeat(1048577))).acquire(signal)).rejects.toThrow('FEED_SIZE_LIMIT');
  expect(()=>parseFeed('<!DOCTYPE rss [<!ENTITY ext SYSTEM "file:///etc/passwd">]><rss/>')).toThrow('UNSAFE_FEED');
});
it('R10-SEC-021: actual HTTP limits reject oversized data before mutation and retain CSP on errors',async()=>{
  const f=fixture(),app=buildServer(f.service,{timers:false});
  try{
    const response=await app.inject({method:'POST',url:`/v1/sessions/${f.id}/messages`,headers:{host:new URL(f.config.publicOrigin).host,authorization:'Bearer '+f.config.adminToken,'content-type':'application/json'},payload:JSON.stringify({text:'x'.repeat(70000)})});
    expect(response.statusCode).toBe(413);expect(response.json().code).toBe('BODY_TOO_LARGE');
    expect(response.headers['content-security-policy']).toContain("script-src 'self'");
    expect(f.service.snapshot(f.id).messages).toHaveLength(0);expect(f.service.session(f.id).call_count).toBe(0);
  }finally{await app.close();f.close();}
});
it('R10-SEC-022: malformed UTF-8 and multibyte oversized credential files fail without returning their values',()=>{
  const dir=mkdtempSync(join(tmpdir(),'credential-byte-boundary-'));
  try{
    const p=ModelProfileSchema.parse({id:'test',provider:'openai',model:'synthetic',baseUrl:'https://fixture.invalid/v1',apiKeyEnv:'MODEL_KEY'});
    const file=join(dir,'key');writeFileSync(file,Buffer.from([0xff,0xfe]));expect(()=>credential(p,{MODEL_KEY_FILE:file})).toThrow('MODEL_CREDENTIAL_FILE_UNREADABLE');
    writeFileSync(file,'あ'.repeat(6000));expect(()=>credential(p,{MODEL_KEY_FILE:file})).toThrow('INVALID_MODEL_CREDENTIAL');
    expect(()=>credential(p,{MODEL_KEY:'あ'.repeat(6000)})).toThrow('INVALID_MODEL_CREDENTIAL');
  }finally{rmSync(dir,{recursive:true,force:true});}
});
