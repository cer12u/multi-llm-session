import React,{useEffect,useRef,useState} from 'react';
import type {SessionBudget} from '../../../packages/session-service/budget.js';
import type {OperationalBudget} from '../../../packages/contracts/budget.js';
type Api=<T>(path:string,body?:unknown,key?:string)=>Promise<T>;
type Report=ReturnType<SessionBudget['report']>;
const initial:OperationalBudget={mode:'continuous',windowMs:3600000,autoRenew:false,maxTokens:null,scopeMaxCalls:null,scopeMaxTokens:null};
const amount=(value:number|null)=>value===null?'不明':value.toLocaleString('ja-JP');

export function BudgetPanel({sessionId,api,refresh}:{sessionId:string;api:Api;refresh:()=>Promise<void>}){
  const [report,setReport]=useState<Report|null>(null),[form,setForm]=useState(initial),[epoch,setEpoch]=useState(0);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const alive=useRef(true),dirty=useRef(false),generation=useRef(0),readRef=useRef(api);readRef.current=api;
  const root=`/v1/sessions/${sessionId}`;
  useEffect(()=>{
    alive.current=true;dirty.current=false;setReport(null);let pending=false;const current=++generation.current;
    const read=async()=>{if(pending)return;pending=true;try{const value=await readRef.current<Report>(root+'/usage');
      if(alive.current&&current===generation.current){setReport(value);if(!dirty.current){setForm(value.policy??initial);setEpoch(value.epoch);}}}
      catch(e){if(alive.current&&current===generation.current)setError(e instanceof Error?e.message:'消費量を取得できませんでした。');}finally{pending=false;}};
    void read();const timer=setInterval(()=>void read(),1500);return()=>{alive.current=false;generation.current++;clearInterval(timer);};
  },[sessionId]);
  function edit(patch:Partial<OperationalBudget>){dirty.current=true;setForm(old=>({...old,...patch}));}
  async function command(action:'save'|'disable'|'renew'|'pause'){
    if(busy)return;
    if(action==='renew'&&!window.confirm('新しい予算を明示的に許可します。過去の消費量・会話・記憶は残し、自動では再開しません。続行しますか？'))return;
    setBusy(true);setError('');setNotice('');const current=generation.current;
    try{await api(root+(action==='renew'?'/budget':action==='pause'?'/pause':'/budget-policy'),action==='save'||action==='disable'?{expectedEpoch:epoch,policy:action==='disable'?null:form}:{});
      const value=await api<Report>(root+'/usage');if(!alive.current||current!==generation.current)return;
      dirty.current=false;setReport(value);setForm(value.policy??initial);setEpoch(value.epoch);setNotice(action==='renew'?'予算を更新しました。再開は別操作です。':'保存済み');await refresh();
    }catch(e){if(alive.current&&current===generation.current)setError(e instanceof Error?e.message:'操作に失敗しました。');}
    finally{if(alive.current&&current===generation.current)setBusy(false);}
  }
  const editable=!!report&&['DRAFT','PAUSED'].includes(report.lifecycle),when=(n:number|null)=>n===null?'未開始':new Date(n).toLocaleString('ja-JP');
  return <section className="budget-panel" aria-label="運用予算と消費量"><h3>運用予算と消費量</h3>
    <p>設定保存・予算更新・再開は別操作です。自動更新は明示的に有効にした場合だけ行い、人間の一時停止は解除しません。</p>
    {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {report&&<><p data-budget-stop>停止理由：{report.stopReason??'なし'} ／ {report.lifecycle}</p>
      <p>現在窓：{when(report.window?.startedAt??null)} ～ {when(report.window?.endsAt??null)} ／ 予約・消費token {amount(report.window?.tokens??null)}</p>
      <p>稼働時間 {Math.floor(report.activeMs/1000)}秒 ／ 窓の実時間 {Math.floor(report.windowWallMs/1000)}秒 ／ 開始から {Math.floor(report.wallMs/1000)}秒</p>
      <fieldset disabled={busy||!editable}><legend>新しい予算方針</legend>
        <label>予算方式<select aria-label="予算方式" value={form.mode} onChange={e=>edit({mode:e.target.value as OperationalBudget['mode'],autoRenew:false})}><option value="experiment">一回の実験</option><option value="continuous">継続運用</option></select></label>
        <label>予算窓（秒）<input aria-label="予算窓（秒）" type="number" min="1" max="604800" value={form.windowMs/1000} onChange={e=>edit({windowMs:Number(e.target.value)*1000})}/></label>
        <label>窓のtoken上限（空欄は未設定）<input aria-label="窓のtoken上限" type="number" min="1" value={form.maxTokens??''} onChange={e=>edit({maxTokens:e.target.value?Number(e.target.value):null})}/></label>
        <label>認証scopeの呼出上限（空欄は未設定）<input aria-label="認証scopeの呼出上限" type="number" min="1" value={form.scopeMaxCalls??''} onChange={e=>edit({scopeMaxCalls:e.target.value?Number(e.target.value):null})}/></label>
        <label>認証scopeのtoken上限（空欄は未設定）<input aria-label="認証scopeのtoken上限" type="number" min="1" value={form.scopeMaxTokens??''} onChange={e=>edit({scopeMaxTokens:e.target.value?Number(e.target.value):null})}/></label>
        <label><input aria-label="予算を自動更新" type="checkbox" disabled={form.mode!=='continuous'} checked={form.autoRenew} onChange={e=>edit({autoRenew:e.target.checked})}/>継続運用の予算を自動更新し、予算停止だけを再開する</label>
        <div className="form-actions"><button type="button" onClick={()=>void command('save')}>予算方針を保存</button><button type="button" onClick={()=>void command('disable')}>手動予算だけに戻す</button><button type="button" onClick={()=>void command('renew')}>予算を明示更新</button></div>
      </fieldset>
      {report.autoResumeEligible&&<button type="button" disabled={busy} onClick={()=>void command('pause')}>自動再開を止めて一時停止</button>}
      <p className="muted">呼出数・発言数・稼働時間の上限は既存の実行設定と併用します。認証scopeは同一の固定期間（UTC基準）を全セッションで共有します。設定変更は消費済み量を消しません。</p>
      <div style={{overflowX:'auto'}}><table><thead><tr><th>用途</th><th>呼出</th><th>実測入力</th><th>実測出力</th><th>usage不明</th><th>予約換算</th><th>応答平均</th></tr></thead><tbody>{report.calls.map(row=><tr key={row.kind+row.stage}><td>{row.kind}/{row.stage}</td><td>{row.calls}</td><td>{amount(row.reportedInput)}</td><td>{amount(row.reportedOutput)}</td><td>{Math.max(row.missingInput,row.missingOutput)}</td><td>{amount(row.chargedTokens)}</td><td>{row.finished?Math.round(row.durationMs/row.finished)+'ms':'不明'}</td></tr>)}</tbody></table></div>
      <p>公開発言の実母数 {report.denominator} ／ 100発言換算の呼出数 {report.callsPer100Posts===null?'算出不可':report.callsPer100Posts.toFixed(1)}{!report.normalized?'（100件未満）':''} ／ 破棄候補 {report.candidates.discarded} ／ 原文検索 {report.recall.lookups}</p>
      <p>usage不明・応答不明は予約量を保持します。表示値は料金・サブスクリプション残量ではありません。金額上限はProvider側でも設定してください。</p>
    </>}
  </section>;
}
