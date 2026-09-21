import React, { useEffect, useRef, useState } from 'react';
import type { PublicAgent } from '../../../packages/contracts/index.js';
import { Composer, emptyDraft } from './chat-components.js';
import { DraftController } from './draft-controller.js';
import { IndexedDraftStore } from './draft-store.js';

type Api=<T>(path:string,body?:unknown,key?:string)=>Promise<T>;
const descriptions:Record<string,string>={
  DRAFT_CONFLICT:'別のタブの新しい版と競合しています。この画面の編集内容は上書きしていません。必要な本文をコピーしてから読み直してください。',
  DRAFT_RESULT_UNKNOWN:'送信結果不明です。元の内容と再送キーを保持しています。新しい投稿の前に結果を確認してください。',
  DRAFT_NO_RECEIPT:'送信結果不明：受領記録をまだ取得できません。未確定とは断定せず、再送時は元の内容と同じキーを使います。',
  DRAFT_SUBMISSION_REJECTED:'入力内容が拒否されました。下書きは保存されています。内容を修正して再送してください。',
  DRAFT_SCOPE_REVOKED:'別のタブでログアウトされました。再度ログインしてください。',
  DRAFT_STORAGE_FULL:'端末の保存容量が不足しています。本文をコピーして保管してください。未保存のまま送信しません。',
};
export function useDurableDrafts(operator:boolean,api:Api,revoked:()=>void):DraftController|null {
  const value=useRef<DraftController|null>(null),apiRef=useRef(api),revokedRef=useRef(revoked);
  const [,update]=useState(0);apiRef.current=api;revokedRef.current=revoked;
  useEffect(()=>{
    if(!operator){value.current=null;update(v=>v+1);return;}
    let closed=false;const store=new IndexedDraftStore();
    const channel=typeof BroadcastChannel==='undefined'?null:new BroadcastChannel('multi-llm-session-draft-events');
    const create=(scope:string)=>new DraftController(scope,store,(path,body,key)=>apiRef.current(path,body,key),()=>update(v=>v+1),signal=>channel?.postMessage(signal));
    void store.owner().then(async scope=>{
      if(closed)return;const controller=create(scope);value.current=controller;update(v=>v+1);
      if(channel)channel.onmessage=event=>{const signal=event.data;if(!signal||signal.scope!==scope||!['changed','clear'].includes(signal.kind))return;controller.receive(signal);if(signal.kind==='clear')revokedRef.current();};
      await controller.initialize();
    }).catch(error=>{
      if(closed)return;const controller=create('0'.repeat(64));controller.error=error instanceof Error?error.message:'DRAFT_STORAGE_UNAVAILABLE';value.current=controller;update(v=>v+1);
    });
    return()=>{closed=true;channel?.close();value.current?.dispose();value.current=null;store.close();};
  },[operator]);
  return operator?value.current:null;
}
export function PersistentComposer({controller,draftKey,title,agents,thread=false,lockedReason,perform,afterSend}: {
  controller:DraftController|null;draftKey:string;title:string;agents:PublicAgent[];thread?:boolean;
  lockedReason?:string;perform:(operation:()=>Promise<void>)=>void;afterSend:()=>Promise<void>;
}) {
  const state=controller?.status(draftKey),draft=controller?.draft(draftKey)??emptyDraft;
  const blocked=!controller?.ready||!!lockedReason||!!state?.unknown||!!state?.conflict;
  const invoke=(operation:()=>Promise<void>)=>perform(async()=>{await operation();await afterSend();});
  const message=!controller?'端末保存を準備中です。':!controller.ready?'端末保存が利用できません。保存状態を確認できないため投稿を停止しています。'
    :state?.busy?'送信中です。内容とキーは端末に保存されています。':state?.conflict?descriptions.DRAFT_CONFLICT:state?.unknown?descriptions[state.error]??descriptions.DRAFT_RESULT_UNKNOWN
    :state?.saving?'端末に保存中です。':state?.error?descriptions[state.error]??'端末への保存に失敗しました。本文をコピーして保管してください。'
    :state?.outbox?.state==='confirmed'?'送信確認済み・下書きは端末に保存済みです。':'下書きは端末に保存済みです。';
  return <>
    <div className="draft-controls" data-draft-key={draftKey}>
      <p className="draft-status" role="status">{message}</p>
      {lockedReason&&<p className="muted">{lockedReason} 下書きは保持し、閲覧・コピーできます。</p>}
      {state?.unknown&&controller&&<div className="form-actions">
        <button type="button" disabled={state.busy||state.saving} onClick={()=>invoke(()=>controller.resolve(draftKey))}>送信結果を確認</button>
        <button type="button" disabled={!!lockedReason||state.busy||state.saving||state.conflict} onClick={()=>invoke(()=>controller.retry(draftKey))}>元の内容を再送</button>
      </div>}
      {state?.conflict&&controller&&<button type="button" disabled={state.busy||state.saving} onClick={()=>perform(()=>controller.reload(draftKey))}>他タブの下書きを読み直す</button>}
    </div>
    <Composer title={title} thread={thread} draft={draft} change={next=>controller?.edit(draftKey,next)}
      send={()=>controller&&invoke(()=>controller.send(draftKey))} pending={state?.busy??false} agents={agents}
      readOnly={!!lockedReason||!controller?.ready} sendBlocked={blocked}
      persistenceHint="この端末に保存・ログアウトで削除" />
  </>;
}
