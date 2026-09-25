import { createHash } from 'node:crypto';
import type {PublicMessage} from '../contracts/index.js';
import { canonical,hash } from '../domain/index.js';
import { diagnosticTables,type Projection } from '../storage-sqlite/diagnostic-migration.js';

export const MAX_DIAGNOSTIC_BYTES=128*1024*1024;
export const MAX_DIAGNOSTIC_ROWS=200000;
export type Row=Record<string,string|number|null>;
export type Header={type:'manifest';kind:'private-session-diagnostic';formatVersion:1;databaseSchema:9;
  sessionId:string;high:number;records:number;baselineRecords:number;stateRows:number;stateHash:string;projection:Projection[];
  manifest:Record<string,unknown>};
export type Frame={type:'change';seq:number;sessionId:string;table:string;key:Row;kind:'BASELINE'|'INSERT'|'UPDATE'|'DELETE';before:Row|null;after:Row|null};
export type Footer={type:'end';records:number;high:number;sha256:string};
export type Snapshot=Array<{table:string;rows:Row[]}>;
const validName=(s:unknown):s is string=>typeof s==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(s)&&!['constructor','prototype','__proto__'].includes(s);
const integer=(n:unknown):n is number=>Number.isSafeInteger(n)&&Number(n)>=0;
function requireValue(value:unknown,code:string):asserts value {if(!value)throw new Error(code);}
function object(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
function row(value:unknown,columns:string[],partial=false):value is Row{
  return object(value)&&(partial||Object.keys(value).length===columns.length)&&Object.keys(value).every(k=>columns.includes(k))&&Object.keys(value).every(c=>Object.hasOwn(value,c)&&
    (value[c]===null||typeof value[c]==='string'||typeof value[c]==='number'&&Number.isFinite(value[c])));
}
const keyFor=(p:Projection,value:Row)=>Object.fromEntries(p.keys.map(k=>[k,value[k]])) as Row;
export const snapshotHash=(snapshot:Snapshot)=>hash(snapshot);

/** Applies recorded data only. No SQL, model, script, configuration, network or runtime command is executed. */
export class Replay {
  readonly header:Header;
  private readonly tables=new Map<string,{projection:Projection;rows:Map<string,Row>}>();
  private count=0;
  private baseline=0;
  private last=0;
  private started=false;
  private rowCount=0;
  constructor(input:unknown){
    requireValue(object(input)&&input.type==='manifest'&&input.kind==='private-session-diagnostic'&&input.formatVersion===1&&input.databaseSchema===9,'REPLAY_MANIFEST_UNSUPPORTED');
    requireValue(typeof input.sessionId==='string'&&/^[0-9a-f-]{36}$/i.test(input.sessionId)&&integer(input.high)&&integer(input.records)&&integer(input.baselineRecords)&&integer(input.stateRows)&&input.stateRows<=MAX_DIAGNOSTIC_ROWS,'REPLAY_MANIFEST_INVALID');
    requireValue(typeof input.stateHash==='string'&&/^[a-f0-9]{64}$/.test(input.stateHash)&&object(input.manifest),'REPLAY_MANIFEST_INVALID');
    requireValue(Array.isArray(input.projection)&&input.projection.length===diagnosticTables.length,'REPLAY_PROJECTION_INVALID');
    for(const candidate of input.projection){
      requireValue(object(candidate)&&typeof candidate.table==='string'&&(diagnosticTables as readonly string[]).includes(candidate.table)&&!this.tables.has(candidate.table),'REPLAY_PROJECTION_INVALID');
      requireValue(Array.isArray(candidate.columns)&&candidate.columns.length>0&&candidate.columns.length<=100&&candidate.columns.every(validName)&&new Set(candidate.columns).size===candidate.columns.length,'REPLAY_PROJECTION_INVALID');
      requireValue(Array.isArray(candidate.keys)&&candidate.keys.length>0&&candidate.keys.length<=8&&candidate.keys.every(k=>(candidate.columns as string[]).includes(k))&&new Set(candidate.keys).size===candidate.keys.length,'REPLAY_PROJECTION_INVALID');
      requireValue(candidate.table!=='runs'||!candidate.columns.includes('token'),'REPLAY_CAPABILITY_FORBIDDEN');
      const projection=candidate as unknown as Projection;this.tables.set(projection.table,{projection,rows:new Map()});
    }
    requireValue([...this.tables.keys()].every((name,i)=>name===diagnosticTables[i]),'REPLAY_PROJECTION_ORDER');
    this.header=input as unknown as Header;
  }
  apply(input:unknown):void {
    requireValue(object(input)&&Object.keys(input).every(k=>['type','seq','sessionId','table','key','kind','before','after'].includes(k))&&input.type==='change'&&input.sessionId===this.header.sessionId&&integer(input.seq)&&input.seq>this.last&&input.seq<=this.header.high,'REPLAY_SEQUENCE_INVALID');
    const table=typeof input.table==='string'?this.tables.get(input.table):undefined;requireValue(table,'REPLAY_TABLE_INVALID');
    const {projection:p,rows}=table;
    requireValue(['BASELINE','INSERT','UPDATE','DELETE'].includes(String(input.kind))&&row(input.key,p.keys),'REPLAY_FRAME_INVALID');
    requireValue(input.before===null||row(input.before,p.columns,input.kind==='UPDATE'),'REPLAY_BEFORE_INVALID');
    requireValue(input.after===null||row(input.after,p.columns,input.kind==='UPDATE'),'REPLAY_AFTER_INVALID');
    const before=input.before as Row|null,after=input.after as Row|null,key=canonical(input.key);
    requireValue((before===null||canonical(keyFor(p,before))===key)&&(after===null||canonical(keyFor(p,after))===key),'REPLAY_KEY_MISMATCH');
    const previous=rows.get(key);
    if(input.kind==='BASELINE'||input.kind==='INSERT'){
      requireValue(before===null&&after!==null&&!previous,'REPLAY_INSERT_CONFLICT');
      if(input.kind==='BASELINE'){requireValue(!this.started,'REPLAY_BASELINE_ORDER');this.baseline++;}else this.started=true;
    }else{
      this.started=true;requireValue(previous&&before&&Object.entries(before).every(([k,v])=>previous[k]===v),'REPLAY_BEFORE_MISMATCH');
      if(input.kind==='DELETE')requireValue(Object.keys(before).length===p.columns.length,'REPLAY_DELETE_INCOMPLETE');
      else requireValue(after&&Object.keys(before).sort().join(',')===Object.keys(after).sort().join(','),'REPLAY_PATCH_KEYS_MISMATCH');
      requireValue(input.kind==='DELETE'?after===null:after!==null,'REPLAY_TRANSITION_INVALID');
    }
    if(!previous&&after)this.rowCount++;else if(previous&&!after)this.rowCount--;
    requireValue(this.rowCount<=MAX_DIAGNOSTIC_ROWS,'REPLAY_ROW_LIMIT');
    if(after)rows.set(key,input.kind==='UPDATE'?{...previous,...after}:after);else rows.delete(key);
    this.last=input.seq;this.count++;requireValue(this.count<=this.header.records,'REPLAY_TOO_MANY_RECORDS');
  }
  snapshot():Snapshot {
    return [...this.tables.values()].map(({projection,rows})=>({table:projection.table,rows:[...rows.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([,r])=>r)}));
  }
  finish():{header:Header;state:Snapshot;transcript:PublicMessage[];records:number}{
    requireValue(this.count===this.header.records&&this.last===this.header.high&&this.baseline===this.header.baselineRecords,'REPLAY_INCOMPLETE');
    const state=this.snapshot();requireValue(state.reduce((n,t)=>n+t.rows.length,0)===this.header.stateRows&&snapshotHash(state)===this.header.stateHash,'REPLAY_STATE_MISMATCH');
    const authors=new Map([...this.tables.get('message_author_snapshots')!.rows.values()].map(r=>[r.message_id,r]));
    const messages=[...this.tables.get('messages')!.rows.values()].sort((a,b)=>Number(a.sequence)-Number(b.sequence));
    const transcript:PublicMessage[]=messages.map(m=>{
      const author=m.author_id===null?null:authors.get(m.id);
      requireValue(m.author_id===null||author&&author.author_id===m.author_id,'REPLAY_AUTHOR_MISSING');
      return {id:String(m.id),sessionId:String(m.session_id),sequence:Number(m.sequence),threadRootId:String(m.thread_root),revision:Number(m.revision),authorId:m.author_id===null?null:String(m.author_id),
        authorName:author?String(author.author_name):'あなた',characterId:author?String(author.character_id):null,characterVersion:author?Number(author.character_version):null,
        text:m.deleted?'':String(m.text),act:String(m.act) as PublicMessage['act'],replyTo:m.reply_to===null?null:String(m.reply_to),addressedTo:JSON.parse(String(m.addressed_json)),deleted:!!m.deleted,
        episode:Number(m.episode),createdAt:Number(m.created_at)};
    });
    return {header:this.header,state,transcript,records:this.count};
  }
}

export class ReplayStream {
  private digest=createHash('sha256');
  private replay:Replay|null=null;
  private footer:Footer|null=null;
  private bytes=0;
  push(line:string):void{
    this.bytes+=Buffer.byteLength(line,'utf8')+1;requireValue(this.bytes<=MAX_DIAGNOSTIC_BYTES&&line.length<=2*1024*1024,'REPLAY_SIZE_LIMIT');
    requireValue(!this.footer&&line.length>0,'REPLAY_TRAILING_DATA');
    let value:unknown;try{value=JSON.parse(line);}catch{throw new Error('REPLAY_INVALID_JSON');}
    if(!this.replay){this.replay=new Replay(value);this.digest.update(line+'\n');return;}
    if(object(value)&&value.type==='end'){
      requireValue(value.records===this.replay.header.records&&value.high===this.replay.header.high&&value.sha256===this.digest.digest('hex'),'REPLAY_DIGEST_MISMATCH');
      this.footer=value as unknown as Footer;return;
    }
    this.replay.apply(value);this.digest.update(line+'\n');
  }
  finish(){requireValue(this.replay&&this.footer,'REPLAY_FOOTER_REQUIRED');return this.replay.finish();}
}
