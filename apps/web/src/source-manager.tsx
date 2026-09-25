import React,{useEffect,useRef,useState} from 'react';
import type {PublicAgent,PublicSession,SourceInput} from '../../../packages/contracts/index.js';
import {SourceSchema} from '../../../packages/contracts/source.js';
import './source-manager.css';

type Api=<T>(path:string,body?:unknown,key?:string)=>Promise<T>;
type Original=SourceInput & {id:string;version:number;fetchedAt:number};
type Summary=Omit<Original,'text'> & {totalCodePoints:number};
type Version={version:number;title:string;fetchedAt:number;publishedAt:string|null};
type Configuration={id:string;url:string|null;intervalMs:number;usable:boolean};
type Feed={id:string;version:number;config_id:string;enabled:number;next_at:number;last_success_at:number|null;last_error:string|null;failures:number;working:boolean;
  definition:{configId:string;url:string;intervalMs:number;audience:string[]|null;enabled:boolean}};
const blank=():SourceInput=>({title:'',text:'',url:null,publishedAt:null,audience:null,enabled:true});
const date=(value:number|null)=>value===null?'未取得':new Date(value).toLocaleString('ja-JP');

/** Operator-only UI. Rendering and metadata refresh never fetch a feed or call a model. */
export function SourceManager({session,agents,api}:{session:PublicSession;agents:PublicAgent[];api:Api}){
  const [items,setItems]=useState<Summary[]>([]),[feeds,setFeeds]=useState<Feed[]>([]),[configs,setConfigs]=useState<Configuration[]>([]);
  const [form,setForm]=useState<SourceInput>(blank),[selected,setSelected]=useState<Original|null>(null),[versions,setVersions]=useState<Version[]>([]),[historical,setHistorical]=useState(false);
  const [feed,setFeed]=useState({configId:'',expectedVersion:0,enabled:true,intervalMs:1800000,audience:null as string[]|null});
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const alive=useRef(true),sequence=useRef(0),saving=useRef(false),reading=useRef(false),apiRef=useRef(api);apiRef.current=api;
  const root=`/v1/sessions/${session.id}`,locked=session.lifecycle==='ENDED';
  async function refresh(){
    if(reading.current)return;reading.current=true;
    try{const [sources,subscriptions,configuration]=await Promise.all([apiRef.current<Summary[]>(root+'/sources'),apiRef.current<Feed[]>(root+'/feeds'),apiRef.current<Configuration[]>('/v1/source-configurations')]);
      if(alive.current){setItems(sources);setFeeds(subscriptions);setConfigs(configuration);}}
    catch{if(alive.current)setError('資料の管理情報を取得できませんでした。');}finally{reading.current=false;}
  }
  useEffect(()=>{alive.current=true;void refresh();const timer=setInterval(()=>void refresh(),3000);return()=>{alive.current=false;sequence.current++;clearInterval(timer);};},[]);
  function reset(){sequence.current++;setForm(blank());setSelected(null);setVersions([]);setHistorical(false);setError('');setNotice('');}
  async function load(id:string,version?:number){
    const expected=++sequence.current;setBusy(true);setError('');setNotice('');
    try{const [record,history]=await Promise.all([api<Original>(root+`/sources/${id}`+(version===undefined?'':`/versions/${version}`)),api<Version[]>(root+`/sources/${id}/versions`)]);
      if(!alive.current||expected!==sequence.current)return;
      const {id:_,version:__,fetchedAt:___,...value}=record;setSelected(record);setForm(value);setVersions(history);setHistorical(record.version!==history[0]?.version);
    }catch(cause){if(alive.current&&expected===sequence.current)setError(cause instanceof Error?cause.message:'資料を取得できませんでした。');}
    finally{if(alive.current&&expected===sequence.current)setBusy(false);}
  }
  async function operation(action:()=>Promise<void>){
    if(saving.current||locked)return;saving.current=true;setBusy(true);setError('');setNotice('');
    try{await action();if(alive.current)await refresh();}
    catch(cause){if(alive.current)setError(cause instanceof Error?cause.message:'保存できませんでした。');}
    finally{saving.current=false;if(alive.current)setBusy(false);}
  }
  async function saveSource(){
    const data=SourceSchema.parse({...form,publishedAt:form.publishedAt?.trim()?new Date(form.publishedAt).toISOString():null,url:form.url?.trim()||null});
    const result=await api<{id:string;version:number}>(root+'/sources'+(selected?'/'+selected.id:''),selected?{...data,expectedVersion:selected.version}:data);
    if(!alive.current)return;await load(result.id);if(alive.current)setNotice(`資料を保存しました：v${result.version}。取得は発言の強制ではありません。`);
  }
  function audience(value:string[]|null,change:(value:string[]|null)=>void,label:string){
    return <fieldset className="source-audience"><legend>{label}</legend>
      <label><input type="checkbox" checked={value===null} onChange={e=>change(e.target.checked?null:[])} />全参加者へ配信</label>
      {value!==null&&agents.map(agent=><label key={agent.id}><input type="checkbox" aria-label={`${label}：${agent.name}`} checked={value.includes(agent.id)} onChange={e=>change(e.target.checked?[...value,agent.id]:value.filter(id=>id!==agent.id))}/>{agent.name}（{agent.slot}）</label>)}
      <small>個別配信は今回のAgent個体だけが対象です。交代したAgentへは継承しません。管理者は監査目的で全資料を閲覧できます。</small>
    </fieldset>;
  }
  function chooseFeed(configId:string){const old=feeds.find(f=>f.config_id===configId),configured=configs.find(c=>c.id===configId);
    setFeed({configId,expectedVersion:old?.version??0,enabled:old?.definition.enabled??true,intervalMs:old?.definition.intervalMs??configured?.intervalMs??1800000,audience:old?.definition.audience??null});}
  return <section className="source-manager" aria-label="資料とフィードの管理">
    <h3>資料とフィードの管理</h3><p className="muted">資料は発言とは別の外部情報です。保存だけでLLMを呼び出さず、稼働中の対象Agentが取り上げる・保留する・無視するかを判断します。</p>
    {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    <div className="source-catalog">{items.map(item=><button type="button" disabled={busy} key={item.id} onClick={()=>void load(item.id)} aria-pressed={selected?.id===item.id}>{item.title} · v{item.version} · {item.enabled?'配信中':'配信停止'} · {item.audience===null?'全員':'個別'}</button>)}</div>
    <button type="button" disabled={busy} onClick={reset}>新しい資料</button>
    {selected&&<div className="source-version"><p>取得日時：{date(selected.fetchedAt)}。公開日時：{selected.publishedAt??'不明'}。</p>
      <label>資料の参照版<select aria-label="資料の参照版" disabled={busy} value={selected.version} onChange={e=>void load(selected.id,Number(e.target.value))}>{versions.map(v=><option key={v.version} value={v.version}>v{v.version} · {v.title}</option>)}</select></label>
      {historical&&<p>旧版の監査表示です。更新は最新の版を読み直してから行ってください。</p>}
    </div>}
    <form onSubmit={e=>{e.preventDefault();void operation(saveSource);}}><fieldset disabled={busy||locked||historical}>
      <legend>資料の追加・改訂</legend>
      <label>資料名<input aria-label="資料名" value={form.title} required maxLength={300} onChange={e=>setForm(v=>({...v,title:e.target.value}))}/></label>
      <label>本文<textarea aria-label="本文" className="source-editor" value={form.text} required maxLength={20000} onChange={e=>setForm(v=>({...v,text:e.target.value}))}/></label>
      <label>出典URL<input aria-label="出典URL" type="url" value={form.url??''} onChange={e=>setForm(v=>({...v,url:e.target.value||null}))}/></label>
      <label>公開日時（ISO 8601・不明なら空欄）<input aria-label="公開日時（ISO 8601・不明なら空欄）" value={form.publishedAt??''} placeholder="2020-01-02T03:04:05Z" onChange={e=>setForm(v=>({...v,publishedAt:e.target.value||null}))}/></label>
      {audience(form.audience,value=>setForm(v=>({...v,audience:value})),'資料の配信先')}
      <label className="source-check"><input type="checkbox" checked={form.enabled} onChange={e=>setForm(v=>({...v,enabled:e.target.checked}))}/>資料の配信を有効にする</label>
      <p className="muted">配信停止・配信先変更は旧runと参照を失効させます。過去の原文・管理者監査履歴・バックアップの完全消去ではありません。</p>
      <button type="submit" className="primary" disabled={form.audience!==null&&!form.audience.length}>{selected?'資料を更新':'資料を追加'}</button>
    </fieldset></form>
    <details className="feed-manager"><summary>設定済みフィードの取得管理</summary>
      <p>配置設定の許可リストから選びます。任意URLの直接取得は行いません。稼働中だけ取得を開始し、実行中の取得が一時停止後に完了する場合は資料として保存します。</p>
      <form onSubmit={e=>{e.preventDefault();void operation(async()=>{const result=await api<{id:string;version:number}>(root+'/feeds',feed);if(alive.current){setFeed(v=>({...v,expectedVersion:result.version}));setNotice(`フィード設定を保存しました：v${result.version}`);}});}}><fieldset disabled={busy||locked}>
        <legend>フィード設定</legend><label>フィード<select aria-label="フィード" value={feed.configId} required onChange={e=>chooseFeed(e.target.value)}><option value="">選択してください</option>{configs.map(c=><option key={c.id} value={c.id} disabled={!c.usable}>{c.id}</option>)}</select></label>
        <label>取得間隔（秒）<input aria-label="取得間隔（秒）" type="number" min={60} max={86400} value={feed.intervalMs/1000} onChange={e=>setFeed(v=>({...v,intervalMs:Number(e.target.value)*1000}))}/></label>
        {audience(feed.audience,value=>setFeed(v=>({...v,audience:value})),'フィードの配信先')}
        <label className="source-check"><input type="checkbox" checked={feed.enabled} onChange={e=>setFeed(v=>({...v,enabled:e.target.checked}))}/>定期取得を有効にする</label>
        <button disabled={!feed.configId||feed.audience!==null&&!feed.audience.length} type="submit">フィード設定を保存</button>
      </fieldset></form>
      {feeds.map(row=><article className="source-feed" key={row.id}><h4>{row.config_id} · v{row.version}</h4><p>{row.enabled?'取得有効':'取得停止'} · {row.working?'取得中':'待機中'}</p>
        <p>次回：{date(row.next_at)}<br/>最終成功：{date(row.last_success_at)}<br/>エラー：{row.last_error??'なし'}（連続 {row.failures} 回）</p>
        <button type="button" disabled={busy||locked||!row.enabled||row.working} onClick={()=>void operation(async()=>{await api(root+`/feeds/${row.id}/retry`,{});if(alive.current)setNotice('再取得を予約しました。停止中の会話は再開しません。');})}>再取得を予約</button>
      </article>)}
      <small>再取得は資料ごとの個別配信先・配信停止を維持します。取得間隔の変更だけでは配信先を変更しません。フィードの配信先を明示的に変更すると既存資料にも適用します。定期取得の停止は既存資料を無効にしません。</small>
    </details>
  </section>;
}
