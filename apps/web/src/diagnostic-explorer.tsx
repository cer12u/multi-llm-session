import React,{useEffect,useRef,useState} from 'react';
import type {diagnosticRun,diagnosticRuns} from '../../../packages/observability/index.js';
import './diagnostic-explorer.css';
type Api=<T>(path:string,body?:unknown,key?:string)=>Promise<T>;
type RunList=ReturnType<typeof diagnosticRuns>;
type Detail=ReturnType<typeof diagnosticRun>;

/** Operator-only projection. Selection, downloads and reconnects never invoke inference. */
export function DiagnosticExplorer({sessionId,api}:{sessionId:string;api:Api}){
  const [list,setList]=useState<RunList>({items:[],nextBefore:null}),[detail,setDetail]=useState<Detail|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const alive=useRef(true),generation=useRef(0),apiRef=useRef(api);apiRef.current=api;
  const root=`/v1/sessions/${sessionId}`;
  useEffect(()=>{alive.current=true;void refresh();return()=>{alive.current=false;generation.current++;};},[sessionId]);
  async function refresh(more=false){
    const token=++generation.current;setBusy(true);setError('');
    try{const next=await apiRef.current<RunList>(root+'/diagnostic-runs'+(more&&list.nextBefore?'?before='+list.nextBefore:''));
      if(alive.current&&token===generation.current)setList(old=>({...next,items:more?[...old.items,...next.items]:next.items}));
    }catch{if(alive.current&&token===generation.current)setError('実行履歴を取得できませんでした。');}
    finally{if(alive.current&&token===generation.current)setBusy(false);}
  }
  async function select(id:string){
    const token=++generation.current;setBusy(true);setError('');setDetail(null);
    try{const value=await apiRef.current<Detail>(root+'/diagnostic-runs/'+id);if(alive.current&&token===generation.current)setDetail(value);}
    catch{if(alive.current&&token===generation.current)setError('実行の詳細を取得できませんでした。');}
    finally{if(alive.current&&token===generation.current)setBusy(false);}
  }
  return <section className="diagnostic-explorer" aria-label="判断と根拠の追跡">
    <h3>判断と根拠の追跡</h3><p>実際に渡した入力・私有状態の差分・候補と確定発言を実行単位で確認します。モデルの内部推論ではありません。</p>
    <p><a href={root+'/transcript'} download>公開会話を書き出す</a></p>
    <p><a href={root+'/diagnostic-export'} download onClick={e=>{if(!window.confirm('人格・私有状態・元資料・未投稿候補を含む管理者専用ファイルです。共有せず安全に保管してください。書き出しますか？'))e.preventDefault();}}>私有診断を書き出す</a></p>
    <p className="muted">再生は記録済みの状態変化を再構築します。LLMの再生成や運用DBへの復元ではありません。移行前は基準状態だけで、未記録の過去は再現しません。</p>
    {error&&<p role="alert">{error}</p>}
    <button type="button" disabled={busy} onClick={()=>void refresh()}>実行履歴を更新</button>
    <div className="diagnostic-run-list">{list.items.map(run=><button type="button" disabled={busy} key={run.id} onClick={()=>void select(run.id)} aria-pressed={detail?.run.id===run.id}>
      {run.kind} · {run.state} · {run.agent_id.slice(0,8)} · {run.id.slice(0,8)}
    </button>)}</div>
    {!list.items.length&&!busy&&<p>記録された実行はありません。</p>}
    {list.nextBefore&&<button type="button" disabled={busy} onClick={()=>void refresh(true)}>以前の実行を取得</button>}
    {detail&&<article aria-label="選択した実行の診断"><h4>{detail.run.kind} · {detail.run.state}</h4><code>{detail.run.id}</code>
      <p>観測：{detail.delivery?.fromInput??'未記録'} → {detail.delivery?.throughInput??'未記録'} / {detail.delivery?.targetInput??'未記録'}。{detail.delivery?.complete?'対象区間を処理済み':'未処理範囲あり'}</p>
      <p>選択した記憶：{detail.recall?.selected.length??0}。予算で除外：{detail.recall?.omittedForBudget.length??0}。入力上限：{detail.inputBudget?.maxTokens??'未記録'}。</p>
      <h5>判断・停止理由</h5>{detail.traces.map(trace=><p key={trace.id}><strong>{trace.code}</strong> {JSON.stringify(trace.detail)}</p>)}
      <h5>元の根拠</h5>{detail.evidence.map(({ref,publicUrl,inspectionUrl},i)=><p key={i}>{ref.kind} · {ref.id} · v{ref.version} {publicUrl?<a href={publicUrl}>原文を表示</a>:<a href={inspectionUrl!} target="_blank" rel="noreferrer">資料の記録版</a>}</p>)}
      <details><summary>私有状態の更新差分</summary><pre>{JSON.stringify(detail.stateChanges,null,2)}</pre></details>
      <details><summary>想起・入力manifest・出典の供給範囲</summary><pre>{JSON.stringify({observation:detail.observation,recall:detail.recall,contexts:detail.contextVersions},null,2)}</pre></details>
      <details><summary>候補の変更・撤回・確定</summary><pre>{JSON.stringify({changes:detail.candidateChanges,published:detail.publishedMessages},null,2)}</pre></details>
      <details><summary>呼び出しと実測／不明usage</summary><pre>{JSON.stringify(detail.calls,null,2)}</pre></details>
      <p className="muted">現在の原文は訂正されている場合があります。判断時の証拠は入力manifestと記録されたcontextを参照してください。</p>
    </article>}
  </section>;
}
