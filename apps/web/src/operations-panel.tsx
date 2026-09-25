import {DiagnosticExplorer} from './diagnostic-explorer.js';
import React, {useEffect,useRef,useState} from 'react';
import {operationLabels,type AgentOperation,type Operations} from '../../../packages/contracts/operations.js';
import {SessionMembers} from './session-members.js';
import './provider-manager.css';
type Api=<T>(path:string,body?:unknown,key?:string)=>Promise<T>;
const date=(value:number|null)=>value===null?'条件待ち／予定なし':new Date(value).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})+' JST';

/** Operator diagnostics are read-only until an explicit, confirmed recovery operation. */
export function OperationsPanel({sessionId,api,refresh}:{sessionId:string;api:Api;refresh:()=>Promise<void>}) {
  const [report,setReport]=useState<Operations|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[revision,setRevision]=useState(0);
  const apiRef=useRef(api),alive=useRef(true),saving=useRef(false);apiRef.current=api;
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{
    let cancelled=false,pending=false;setReport(null);
    const read=async()=>{if(pending)return;pending=true;try{const next=await apiRef.current<Operations>(`/v1/sessions/${sessionId}/operations`);if(!cancelled){setReport(next);setError('');}}catch(cause){if(!cancelled)setError(cause instanceof Error?cause.message:'実行状況を取得できませんでした。');}finally{pending=false;}};
    void read();const timer=setInterval(()=>void read(),1500);return()=>{cancelled=true;clearInterval(timer);};
  },[sessionId,revision]);
  async function recover(path:string,confirmation:string){
    if(saving.current||!window.confirm(confirmation))return;saving.current=true;setBusy(true);setError('');
    try{await api(path,{});if(alive.current){setRevision(v=>v+1);await refresh();}}
    catch(cause){if(alive.current)setError(cause instanceof Error?cause.message:'復旧操作が失敗しました。');}
    finally{saving.current=false;if(alive.current)setBusy(false);}
  }
  function buttons(row:AgentOperation){
    const stopped=!report||report.session.lifecycle==='ENDED'||row.reason==='BUDGET_STOPPED';
    const profile=row.frozen.profile;
    return <div className="form-actions">
      <button type="button" disabled={busy||stopped||!row.agent.enabled} onClick={()=>void recover(`/v1/sessions/${sessionId}/agents/${row.agent.id}/retry`,'このAgentの古い実行を失効させ、現在の予算内で再試行します。停止中のセッションは自動再開しません。続行しますか？')}>Agentを再試行</button>
      {profile.provider!=='mock'&&<button type="button" disabled={busy||stopped||row.frozen.health.state==='HALF_OPEN'} onClick={()=>void recover(`/v1/model-profiles/${encodeURIComponent(profile.id)}/versions/${profile.version}/retry`,'表示された固定版のProvider scopeに単一probeを許可します。同じscopeのAgentにも適用されます。外部処理中の枠は期限まで保持し、終了・予算停止を解除しません。続行しますか？')}>固定版のProviderを再試行</button>}
    </div>;
  }
  return <section className="operations-panel" aria-label="Agent実行状況と復旧">
    <h3>Agent実行状況と復旧</h3><p className="muted">閲覧・再描画・更新だけでは推論を開始しません。再試行は以前の遅延結果を失効させ、既存予算内で行います。</p>
    {error&&<p role="alert">{error}</p>}
    {!report&&!error&&<p role="status">実行状況を取得中</p>}
    {report&&<><p>取得時刻：{date(report.now)}</p><p>予算窓：{report.session.budget.callsUsed}/{report.session.settings.maxCalls} calls · {report.session.budget.messagesUsed}/{report.session.settings.maxMessages} 発言</p>
      <div className="form-actions">
        {report.session.lifecycle==='RUNNING'&&<button type="button" disabled={busy} onClick={()=>void recover(`/v1/sessions/${sessionId}/pause`,'セッションを一時停止します。送信済みの外部推論が取り消される保証はありません。続行しますか？')}>診断から一時停止</button>}
        {report.session.lifecycle==='PAUSED'&&<button type="button" disabled={busy||report.session.activity==='BUDGET_PAUSED'} onClick={()=>void recover(`/v1/sessions/${sessionId}/resume`,'既存の予算内でセッションを再開します。続行しますか？')}>診断から再開</button>}
      </div>
      <SessionMembers sessionId={sessionId} currentEpoch={report.session.epoch} lifecycle={report.session.lifecycle} api={api} refresh={refresh}/>
      {report.agents.map(row=><article className="agent-operation" key={row.agent.id} data-operation-agent={row.agent.id}>
        <h4>{row.agent.name}</h4><p className="operation-reason">{operationLabels[row.reason]}</p>
        <p>次の機会：{date(row.nextOpportunityAt)}</p>{row.waitingFor&&<p>返答待ちの相手：{report.agents.find(a=>a.agent.id===row.waitingFor)?.agent.name??row.waitingFor}</p>}
        <p>固定設定：{row.frozen.profile.id} v{row.frozen.profile.version} ／ 最新 v{row.latestVersion}</p>
        <p>送信先：{row.frozen.profile.provider} · {row.frozen.profile.model} · {row.frozen.profile.baseUrl??'模擬（外部送信なし）'}</p>
        <p>認証参照：{row.frozen.profile.apiKeyEnv??'なし'} ／ Core確認：{row.frozen.credentialConfiguredOnCore?'設定あり／認証不要':'未設定・読取不可（Worker配置は別確認）'}</p>
        <p>定義hash：<code>{row.frozen.hash}</code></p><p>scope：<code>{row.frozen.health.scope}</code></p>
        <p>状態：{row.frozen.health.state} ／ 失敗 {row.errorCount} ／ 最後のエラー {row.lastError??'なし'}</p>
        <p>未処理：観測 {row.observationPending} · 記憶 {row.memoryPending} ／ 候補 {row.candidateState??'なし'}</p>
        {buttons(row)}
      </article>)}
      <DiagnosticExplorer sessionId={sessionId} api={api}/>
    </>}
  </section>;
}
