import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Character, PublicSession, Settings, Snapshot } from '../../../packages/contracts/index.js';
import './style.css';
import {subscribeSession} from './event-stream.js';

type Auth={role:'operator'|'viewer';csrf:string};
type Capabilities={profiles:{id:string;provider:string;model:string}[];slots:string[];defaults:Settings;liveEnabled:boolean};
function App(){
  const [auth,setAuth]=useState<Auth|null>(null),[token,setToken]=useState(''),[error,setError]=useState('');
  const [sessions,setSessions]=useState<PublicSession[]>([]),[selected,setSelected]=useState<string|null>(null),[snapshot,setSnapshot]=useState<Snapshot|null>(null);
  const [characters,setCharacters]=useState<Character[]>([]),[caps,setCaps]=useState<Capabilities|null>(null);
  const [title,setTitle]=useState('自由な会話'),[members,setMembers]=useState<{characterId:string;profileId:string;slot:string}[]>([]);
  const [text,setText]=useState(''),[replyTo,setReplyTo]=useState<string|null>(null),[addressedTo,setAddressedTo]=useState('');
  const [pending,setPending]=useState(false),[diagnostic,setDiagnostic]=useState<unknown>(null),[showDiagnostic,setShowDiagnostic]=useState(false);
  const [sourceTitle,setSourceTitle]=useState(''),[sourceText,setSourceText]=useState(''),[search,setSearch]=useState(''),[searchResult,setSearchResult]=useState<unknown>(null);
  const [settingsText,setSettingsText]=useState(''),[importText,setImportText]=useState(''),[connection,setConnection]=useState('未接続');
  const messageKey=useRef<{signature:string;key:string}|null>(null);
  const operator=auth?.role==='operator';
  const currentSelection=useRef(selected);currentSelection.current=selected;
  async function api<T>(path:string,body?:unknown,idem:string=crypto.randomUUID()):Promise<T>{
    let response:Response|undefined;
    for(let attempt=0;attempt<2;attempt++){
      try{response=await fetch(path,{method:body===undefined?'GET':'POST',credentials:'same-origin',headers:body===undefined?{}:{'content-type':'application/json','x-csrf-token':auth?.csrf??'','idempotency-key':idem},body:body===undefined?undefined:JSON.stringify(body)});break;}
      catch(e){if(attempt)throw e;}
    }
    if(!response)throw new Error('ネットワーク接続を確認してください');
    const value=await response.json();
    if(!response.ok){if(response.status===401)setAuth(null);throw new Error(value.code??`HTTP ${response.status}`);}return value as T;
  }
  const safe=(operation:()=>Promise<void>)=>{setError('');void operation().catch(e=>setError(e instanceof Error?e.message:'操作に失敗しました'));};
  async function refresh(id=selected){
    const list=await api<PublicSession[]>('/v1/sessions');setSessions(list);
    if(id){const next=await api<Snapshot>(`/v1/sessions/${id}/snapshot`);if(currentSelection.current===id)setSnapshot(next);}
  }
  async function initialize(){
    const [cs,cp,ss]=await Promise.all([api<Character[]>('/v1/characters'),api<Capabilities>('/v1/capabilities'),api<PublicSession[]>('/v1/sessions')]);
    setCharacters(cs);setCaps(cp);setSessions(ss);
    setMembers(cp.slots.slice(0,3).map((slot,i)=>({slot,characterId:cs[i%cs.length].id,profileId:cp.profiles.find(p=>p.provider==='mock')?.id??cp.profiles[0].id})));
  }
  useEffect(()=>{void fetch('/v1/auth/me').then(async r=>{if(r.ok)setAuth(await r.json());}).catch(()=>{});},[]);
  useEffect(()=>{if(auth)safe(initialize);else{setSnapshot(null);setSessions([]);}},[auth?.role]);
  useEffect(()=>{
    if(!auth||!selected)return;setSnapshot(null);let first=true;
    const stop=subscribeSession(()=>api<Snapshot>(`/v1/sessions/${selected}/snapshot`),next=>{
      setSnapshot(next);setSessions(values=>values.map(value=>value.id===next.session.id?next.session:value));
      if(first){setSettingsText(JSON.stringify(next.session.settings,null,2));first=false;}
    },setConnection);
    return()=>{stop();setConnection('未接続');};
  },[selected,auth?.role]);
  useEffect(()=>{
    if(!showDiagnostic||!selected||!operator)return;
    let closed=false;const update=()=>{void api<unknown>(`/v1/sessions/${selected}/diagnostics`).then(v=>{if(!closed)setDiagnostic(v);}).catch(()=>{});};
    update();const timer=setInterval(update,1500);return()=>{closed=true;clearInterval(timer);};
  },[showDiagnostic,selected,operator]);
  async function submitMessage(){
    if(!selected||!text.trim()||pending)return;setPending(true);
    const body={text,replyTo,addressedTo:addressedTo?[addressedTo]:[]},signature=JSON.stringify({selected,...body});
    if(messageKey.current?.signature!==signature)messageKey.current={signature,key:crypto.randomUUID()};
    try{await api(`/v1/sessions/${selected}/messages`,body,messageKey.current.key);setText('');setReplyTo(null);messageKey.current=null;await refresh();}finally{setPending(false);}
  }
  async function control(action:string){if(!selected)return;await api(`/v1/sessions/${selected}/${action}`,{});await refresh();}
  async function exportSession(){
    if(!selected)return;const value=await api(`/v1/sessions/${selected}/export`),url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download=`session-${selected}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  if(!auth)return <main className="login"><h1>Multi LLM Session</h1><p>独立したキャラクターの会話を観察する実験アプリ</p><form onSubmit={e=>{e.preventDefault();safe(async()=>{const response=await fetch('/v1/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token})});const value=await response.json();if(!response.ok)throw new Error(value.code);setAuth(value);setToken('');});}}><label>ログイントークン<input autoComplete="current-password" type="password" value={token} onChange={e=>setToken(e.target.value)} required/></label><button type="submit">ログイン</button></form>{error&&<p role="alert" className="error">{error}</p>}<small>ローカル起動時のターミナル、または管理者から受け取ったトークンを入力してください。</small></main>;
  return <div className="app"><header><div><h1>Multi LLM Session</h1><span>独立Agent / 専用セッション</span></div><div><span className="badge">{operator?'管理者':'閲覧者'}</span><button onClick={()=>safe(async()=>{await api('/v1/auth/logout',{});setAuth(null);})}>ログアウト</button></div></header>
    {error&&<div className="error" role="alert">{error}<button onClick={()=>setError('')}>閉じる</button></div>}
    <div className="workspace"><aside><h2>セッション</h2><button onClick={()=>safe(()=>refresh())}>一覧を更新</button><nav>{sessions.map(s=><button className={selected===s.id?'session selected':'session'} key={s.id} onClick={()=>{setSelected(s.id);setSearchResult(null);setReplyTo(null);}}><strong>{s.title}</strong><span>{s.lifecycle} · {s.botMessages} 発言</span></button>)}</nav>
      {operator&&caps&&<details open={!sessions.length}><summary>新しいセッション</summary><form onSubmit={e=>{e.preventDefault();safe(async()=>{const created=await api<{id:string}>('/v1/sessions',{title,participants:members,settings:caps.defaults});await refresh(created.id);setSelected(created.id);});}}>
        <label>セッション名<input value={title} onChange={e=>setTitle(e.target.value)} required maxLength={120}/></label>
        {members.map((m,i)=><fieldset key={m.slot}><legend>参加者 {i+1}</legend><label>キャラクター<select value={m.characterId} onChange={e=>setMembers(ms=>ms.map((v,j)=>j===i?{...v,characterId:e.target.value}:v))}>{characters.map(c=><option key={c.id} value={c.id}>{c.name} v{c.version}</option>)}</select></label><label>モデル<select value={m.profileId} onChange={e=>setMembers(ms=>ms.map((v,j)=>j===i?{...v,profileId:e.target.value}:v))}>{caps.profiles.map(p=><option key={p.id} value={p.id}>{p.provider==='mock'?'模擬モデル':p.model}</option>)}</select></label></fieldset>)}
        {members.length<caps.slots.length&&<button type="button" onClick={()=>setMembers(ms=>[...ms,{slot:caps.slots[ms.length],characterId:characters[ms.length%characters.length].id,profileId:caps.profiles[0].id}])}>参加者を追加</button>}
        {members.length>3&&<button type="button" onClick={()=>setMembers(ms=>ms.slice(0,-1))}>最後の参加者を外す</button>}
        <button type="submit" className="primary">セッションを作成</button><small>作成だけでは推論を開始しません。</small></form></details>}
    </aside><main className="conversation">{snapshot?<>
      <section className="session-header"><h2>{snapshot.session.title}</h2><span className="badge">{snapshot.session.mode==='mock'?'MOCK · 模擬応答':'LIVE · 実LLM'}</span><p>{snapshot.session.lifecycle} / {snapshot.session.activity} · {connection} · revision {snapshot.session.revision}</p>
        {snapshot.session.mode==='mock'&&<p className="notice">模擬モデルは制御試験用の定型応答です。自然なLLM会話の品質を示すものではありません。</p>}
        <div className="controls">{operator&&<>{snapshot.session.lifecycle==='DRAFT'&&<button onClick={()=>safe(()=>control('start'))}>開始</button>}{snapshot.session.lifecycle==='RUNNING'&&<button onClick={()=>safe(()=>control('pause'))}>一時停止</button>}{snapshot.session.lifecycle==='PAUSED'&&<button onClick={()=>safe(()=>control('resume'))}>再開</button>}{snapshot.session.lifecycle!=='ENDED'&&<button onClick={()=>safe(()=>control('end'))}>終了</button>}<button onClick={()=>safe(exportSession)}>会話を出力</button><button onClick={()=>setShowDiagnostic(v=>!v)}>診断</button></>}</div>
        <p>推論 {snapshot.session.calls} / {snapshot.session.settings.maxCalls} 回 · Bot発言 {snapshot.session.botMessages} / {snapshot.session.settings.maxMessages} 件{snapshot.session.stopReason&&` · 停止理由: ${snapshot.session.stopReason}`}</p>
        <div className="participants">{snapshot.agents.map(a=><div key={a.id}><strong>{a.name}</strong><small>{a.enabled?a.status:'disabled'}</small></div>)}</div>
      </section>
      <section className="messages" aria-label="会話履歴" aria-live="polite">{snapshot.messages.length===0?<p>題材を入力するか、「開始」でAgent自身の参加判断を始めてください。</p>:snapshot.messages.map(m=><article key={m.id} className={m.authorId?'message bot':'message human'} data-author={m.authorId??'human'}><div><strong>{m.authorName}</strong><time>{new Date(m.createdAt).toLocaleTimeString('ja-JP')}</time><small>episode {m.episode}</small></div>{m.replyTo&&<small>返信先 {m.replyTo.slice(0,8)}</small>}<p>{m.deleted?'（削除済み）':m.text}</p>{operator&&!m.deleted&&snapshot.session.lifecycle!=='ENDED'&&<div><button onClick={()=>setReplyTo(m.id)}>返信</button><button onClick={()=>safe(async()=>{await api(`/v1/sessions/${selected}/messages/${m.id}`,{text:null});await refresh();})}>削除</button></div>}</article>)}</section>
      {operator&&snapshot.session.lifecycle!=='ENDED'&&<form className="composer" onSubmit={e=>{e.preventDefault();safe(submitMessage);}}>{replyTo&&<div>返信先 {replyTo.slice(0,8)} <button type="button" onClick={()=>setReplyTo(null)}>解除</button></div>}<label>発言<textarea value={text} onChange={e=>setText(e.target.value)} disabled={pending} maxLength={8000} rows={3}/></label><div><label>宛先<select value={addressedTo} onChange={e=>setAddressedTo(e.target.value)}><option value="">全員</option>{snapshot.agents.filter(a=>a.enabled).map(a=><option value={a.id} key={a.id}>{a.name}</option>)}</select></label><button className="primary" disabled={pending||!text.trim()}>{pending?'送信中':'送信'}</button></div></form>}
      <details><summary>過去の発言を検索</summary><form onSubmit={e=>{e.preventDefault();safe(async()=>setSearchResult(await api(`/v1/sessions/${selected}/search?q=${encodeURIComponent(search)}`)));}}><label>検索語<input value={search} onChange={e=>setSearch(e.target.value)} required maxLength={200}/></label><button>検索</button></form>{searchResult!==null&&<pre>{JSON.stringify(searchResult,null,2)}</pre>}</details>
      {operator&&<><details><summary>資料を投入</summary><form onSubmit={e=>{e.preventDefault();safe(async()=>{await api(`/v1/sessions/${selected}/sources`,{title:sourceTitle,text:sourceText});setSourceText('');setSourceTitle('');});}}><label>資料名<input value={sourceTitle} onChange={e=>setSourceTitle(e.target.value)} required maxLength={300}/></label><label>本文<textarea value={sourceText} onChange={e=>setSourceText(e.target.value)} required maxLength={20000}/></label><button disabled={snapshot.session.lifecycle==='ENDED'}>資料を追加</button></form></details>
      <details><summary>実行設定（停止中のみ変更可能）</summary><textarea className="settings" value={settingsText} onChange={e=>setSettingsText(e.target.value)}/><button disabled={!['DRAFT','PAUSED'].includes(snapshot.session.lifecycle)} onClick={()=>safe(async()=>{await api(`/v1/sessions/${selected}/settings`,JSON.parse(settingsText));await refresh();})}>設定を保存</button></details>
      {showDiagnostic&&<section className="diagnostics"><h3>管理者向け診断</h3><p>未投稿候補・参加判断の状態です。一般の表示Clientには配信されません。</p><pre>{JSON.stringify(diagnostic,null,2)}</pre></section>}</>}
    </>:<section className="empty"><h2>会話を観察する準備</h2><p>セッションを作成し、3名以上のキャラクターを参加させます。固定順や司会LLMは使用しません。</p><p>キャラクター・私有記憶・会話表示は分離されています。初期表示はテキストのみです。</p></section>}
    </main></div>{operator&&<footer><details><summary>キャラクター定義の追加・更新</summary><p>既存のversionは変更不可です。更新はversionを増やしたJSONを入力します。稼働中セッションの人格は変わりません。</p><textarea value={importText} onChange={e=>setImportText(e.target.value)} placeholder='{"schemaVersion":1,"id":"example","version":1,"name":"名前","persona":"設定","presentationRef":null}'/><button onClick={()=>safe(async()=>{await api('/v1/characters',JSON.parse(importText));setImportText('');await initialize();})}>定義を保存</button></details></footer>}</div>;
}

createRoot(document.getElementById('root')!).render(<App/>);
