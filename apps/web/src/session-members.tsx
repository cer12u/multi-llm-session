import React,{useEffect,useRef,useState} from 'react';
import type {Lifecycle} from '../../../packages/contracts/index.js';
import {MembershipUpdateSchema,type MemberSelection,type MembershipReport} from '../../../packages/contracts/session-membership.js';
import './session-members.css';
type Api=<T>(path:string,body?:unknown,key?:string)=>Promise<T>;
const when=(value:number|null)=>value===null?'未確定':new Date(value).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})+' JST';
const refValue=(ref:{id:string;version:number})=>JSON.stringify(ref);
const selections=(report:MembershipReport):MemberSelection[]=>report.current.map(row=>({agentId:row.agent.id,slot:row.agent.slot,character:row.character,profile:row.profile,enabled:row.agent.enabled}));

/** An explicitly loaded editor, not a polling projection that discards unsaved changes. */
export function SessionMembers({sessionId,currentEpoch,lifecycle,api,refresh}:{sessionId:string;currentEpoch:number;lifecycle:Lifecycle;api:Api;refresh:()=>Promise<void>}){
  const [report,setReport]=useState<MembershipReport|null>(null),[rows,setRows]=useState<MemberSelection[]>([]);
  const [busy,setBusy]=useState(false),[dirty,setDirty]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [cloneTitle,setCloneTitle]=useState(''),[acknowledged,setAcknowledged]=useState(false),[cloned,setCloned]=useState<string|null>(null);
  const alive=useRef(true),generation=useRef(0),saving=useRef(false),apiRef=useRef(api);apiRef.current=api;
  const retry=useRef<{signature:string;key:string}|null>(null),cloneRetry=useRef<{signature:string;key:string}|null>(null);
  function accept(next:MembershipReport){setReport(next);setRows(selections(next));setDirty(false);}
  async function load(discard=false){
    if(saving.current||discard&&dirty&&!window.confirm('未保存の参加者編集を破棄して再取得しますか？'))return;
    const attempt=++generation.current;setBusy(true);setError('');
    try{const next=await apiRef.current<MembershipReport>(`/v1/sessions/${sessionId}/membership`);if(alive.current&&attempt===generation.current){accept(next);retry.current=null;}}
    catch(cause){if(alive.current&&attempt===generation.current)setError(cause instanceof Error?cause.message:'参加者を取得できませんでした。');}
    finally{if(alive.current&&attempt===generation.current)setBusy(false);}
  }
  useEffect(()=>{alive.current=true;void load();return()=>{alive.current=false;generation.current++;};},[sessionId]);
  const stale=report!==null&&report.epoch!==currentEpoch;
  const editable=!busy&&!stale&&(lifecycle==='DRAFT'||lifecycle==='PAUSED');
  function edit(index:number,change:Partial<MemberSelection>){setRows(value=>value.map((row,i)=>i===index?{...row,...change}:row));setDirty(true);setNotice('');}
  function add(){if(!report)return;const slot=report.slots.find(slot=>!rows.some(row=>row.slot===slot)),character=report.characters[0],profile=report.profiles[0];if(!slot||!character||!profile)return;
    setRows(value=>[...value,{agentId:null,slot,character:{id:character.id,version:character.version},profile:{id:profile.id,version:profile.version},enabled:true}]);setDirty(true);}
  async function save(){
    if(saving.current||!editable||!report)return;
    const parsed=MembershipUpdateSchema.safeParse({expectedEpoch:report.epoch,participants:rows});
    if(!parsed.success){setError('参加者は3〜16体、Worker枠は重複不可です。版と参加者の設定を確認してください。');return;}
    if(!window.confirm('選択した版を明示的に適用し、古い実行と未投稿候補を失効させます。交代するAgentは新しい個体になり、退出者の私有記憶は引き継ぎません。続行しますか？'))return;
    saving.current=true;setBusy(true);setError('');const attempt=++generation.current,signature=JSON.stringify(parsed.data);
    if(retry.current?.signature!==signature)retry.current={signature,key:crypto.randomUUID()};
    try{const next=await api<MembershipReport>(`/v1/sessions/${sessionId}/membership`,parsed.data,retry.current.key);
      if(!alive.current||attempt!==generation.current)return;accept(next);retry.current=null;setNotice('参加者設定を保存しました。セッションは自動再開していません。');await refresh();}
    catch(cause){if(alive.current&&attempt===generation.current)setError(cause instanceof Error?cause.message:'保存できませんでした。編集内容は保持しています。');}
    finally{saving.current=false;if(alive.current&&attempt===generation.current)setBusy(false);}
  }
  async function clone(){
    if(saving.current||!acknowledged||!cloneTitle.trim())return;
    const body={title:cloneTitle,copy:'definitions-only'},signature=JSON.stringify(body),attempt=++generation.current;
    if(cloneRetry.current?.signature!==signature)cloneRetry.current={signature,key:crypto.randomUUID()};
    saving.current=true;setBusy(true);setError('');
    try{const result=await api<{id:string}>(`/v1/sessions/${sessionId}/clone`,body,cloneRetry.current.key);
      if(alive.current&&attempt===generation.current){setCloned(result.id);setNotice('定義だけの新しい開始前セッションを作成しました。元のセッションは変更していません。');await refresh();}}
    catch(cause){if(alive.current&&attempt===generation.current)setError(cause instanceof Error?cause.message:'複製できませんでした。');}
    finally{saving.current=false;if(alive.current&&attempt===generation.current)setBusy(false);}
  }
  return <details className="session-members"><summary>参加者と継続設定</summary>
    <section aria-label="セッション参加者の編集">
      <p>同じ個体への版適用では本人の記憶を保持します。別のキャラクターへの交代は新しい個体です。退出者の履歴は残り、私有記憶を新しい個体へ移しません。</p>
      <p>編集は開始前・一時停止中のみです。Worker接続数は発言中の人数ではありません。</p>
      {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
      {stale&&<p role="alert">セッションの世代が変わりました。未保存編集は保持しています。参加者を再取得して確認してください。</p>}
      <button type="button" disabled={busy} onClick={()=>void load(true)}>参加者を再取得</button>
      {report&&<><p className="membership-counts">取得時点：登録 {report.counts.current} ／ 有効 {report.counts.enabled} ／ 接続中 {report.counts.online} ／ 無効 {report.counts.disabled} ／ 未接続 {report.counts.offline} ／ エラーあり {report.counts.errors}</p>
        <form onSubmit={event=>{event.preventDefault();void save();}}><fieldset disabled={!editable}><legend>適用する参加者と固定版</legend>
          {rows.map((row,index)=><fieldset key={index} className="member-selection" data-member-index={index}><legend>参加者 {index+1}</legend>
            <p>{row.agentId?'継続する個体：'+row.agentId:'新しい個体（保存時に作成）'}</p>
            <label>Worker枠<select aria-label={`参加者${index+1}のWorker枠`} disabled={row.agentId!==null} value={row.slot} onChange={e=>edit(index,{slot:e.target.value})}>{report.slots.map(slot=><option key={slot} value={slot} disabled={rows.some((other,i)=>i!==index&&other.slot===slot)}>{slot}</option>)}</select></label>
            <label>人格の固定版<select aria-label={`参加者${index+1}の人格版`} value={refValue(row.character)} onChange={e=>edit(index,{character:JSON.parse(e.target.value)})}>{report.characters.filter(c=>row.agentId===null||c.id===row.character.id).map(c=><option key={refValue(c)} value={refValue({id:c.id,version:c.version})}>{c.name} · {c.id} v{c.version}</option>)}</select></label>
            <label>モデルの固定版<select aria-label={`参加者${index+1}のモデル版`} value={refValue(row.profile)} onChange={e=>edit(index,{profile:JSON.parse(e.target.value)})}>{report.profiles.map(p=><option key={refValue(p)} value={refValue({id:p.id,version:p.version})}>{p.id} v{p.version} · {p.provider} / {p.model}</option>)}</select></label>
            <label className="member-check"><input type="checkbox" checked={row.enabled} onChange={e=>edit(index,{enabled:e.target.checked})}/>このAgentを有効にする</label>
            <div className="form-actions">{row.agentId&&<button type="button" onClick={()=>edit(index,{agentId:null})}>別のAgentとして交代</button>}<button type="button" disabled={rows.length<=3} onClick={()=>{setRows(value=>value.filter((_,i)=>i!==index));setDirty(true);}}>この参加者を外す</button></div>
          </fieldset>)}
          <button type="button" disabled={rows.length>=16||rows.length>=report.slots.length} onClick={add}>参加者を追加</button>
          <button type="submit" className="primary" disabled={!dirty}>参加者設定を保存</button>
        </fieldset></form>
        <details><summary>退出した個体（{report.archived.length}）</summary>{report.archived.map(row=><p key={row.agent.id}>{row.agent.name} · {row.agent.id} ／ 退出 {when(row.retiredAt)}。記憶の所有者は変更しません。</p>)}</details>
        <details><summary>エピソードの時刻と範囲</summary>{report.episodes.map(e=><p key={e.number}>#{e.number} ／ {when(e.startedAt)} 〜 {when(e.closedAt)} ／ 発言番号 {e.firstSequence}〜{e.lastSequence} ／ {e.origin}</p>)}<p>区切りは索引です。過去の発言や私有記憶を削除・分断しません。</p></details>
      </>}
      <form className="session-clone" onSubmit={event=>{event.preventDefault();void clone();}}><h4>定義だけで新しいセッションを作成</h4>
        <label>複製先のセッション名<input aria-label="複製先のセッション名" required maxLength={120} value={cloneTitle} onChange={e=>{setCloneTitle(e.target.value);setCloned(null);}} disabled={busy}/></label>
        <label className="member-check"><input type="checkbox" checked={acknowledged} onChange={e=>setAcknowledged(e.target.checked)} disabled={busy}/>固定された人格・モデル・設定だけをコピーし、公開履歴・私有記憶・未解決事項・予定はコピーしないことを確認しました</label>
        <button type="submit" disabled={busy||!acknowledged||!cloneTitle.trim()||cloned!==null}>定義だけを複製</button>
        {cloned&&<p><a href={`/?session=${encodeURIComponent(cloned)}`}>複製した開始前セッションを開く</a></p>}
      </form>
    </section>
  </details>;
}
