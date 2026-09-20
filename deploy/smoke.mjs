// Run inside Core container with stdin: docker compose exec -T core node --input-type=module < deploy/smoke.mjs
import {randomUUID} from 'node:crypto';
const base='http://127.0.0.1:3000',token=process.env.ADMIN_TOKEN;
if(!token)throw new Error('ADMIN_TOKEN is required');
async function request(path,body){const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','idempotency-key':randomUUID()},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(5000)});if(!response.ok)throw new Error('Container smoke HTTP '+response.status);return response.json();}
const {id}=await request('/v1/sessions',{title:'Container mock smoke',participants:['a','b','c'].map((v,i)=>({slot:'worker-'+v,characterId:['sora','nagi','rin'][i],profileId:'mock'})),settings:{debounceMs:0,maxCoalesceMs:0,directedDebounceMs:0,arbitrationMs:20,postGapMs:50,agentCooldownMs:100,replyGraceMs:0,maxMessages:6,maxCalls:150,maxDurationMs:60000,memoryEvery:100}});
await request(`/v1/sessions/${id}/messages`,{text:'コンテナ間の独立会話を確認します。'});await request(`/v1/sessions/${id}/start`,{});
const deadline=Date.now()+45000;let snapshot;
while(Date.now()<deadline){snapshot=await request(`/v1/sessions/${id}/snapshot`);if(snapshot.session.lifecycle!=='RUNNING')break;await new Promise(r=>setTimeout(r,200));}
const authors=new Set(snapshot.messages.filter(m=>m.authorId).map(m=>m.authorId));
if(authors.size!==3||snapshot.session.botMessages!==6||snapshot.session.stopReason!=='MAX_MESSAGES')throw new Error('Container workers did not complete their bounded mock conversation');
console.log(JSON.stringify({mode:'mock',containerAgents:authors.size,posts:snapshot.session.botMessages,stopReason:snapshot.session.stopReason}));
