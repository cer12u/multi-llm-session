import React, { useEffect, useRef, useState } from 'react';
import { ModelProfileSchema, type ModelProfile, type ProviderCapabilities } from '../../../packages/contracts/index.js';
import type { ProviderReport } from '../../../packages/contracts/operations.js';
import './provider-manager.css';

type Api = <T>(path: string, body?: unknown, key?: string) => Promise<T>;
const defaults = (): ModelProfile => ({ ...ModelProfileSchema.parse({id:'new-profile',provider:'openai',model:'model'}), id:'',model:'',baseUrl:'',apiKeyEnv:'MODEL_API_KEY',capabilities:{jsonModes:['none','json','schema'],outputTokenParameter:'max_tokens',temperatureSupported:true,usage:'unknown'} });
const inferred = (p:ModelProfile):ProviderCapabilities => p.capabilities ?? {jsonModes:['none','json','schema'],outputTokenParameter:p.provider==='ollama'?'num_predict':'max_tokens',temperatureSupported:true,usage:'unknown'};

/** Edits immutable configuration, never credentials and never an implicit inference probe. */
export function ProviderManager({api,refresh}:{api:Api;refresh:()=>Promise<void>}) {
  const [catalog,setCatalog]=useState<ProviderReport[]>([]),[versions,setVersions]=useState<ProviderReport[]>([]);
  const [form,setForm]=useState<ModelProfile>(defaults),[selected,setSelected]=useState<string|null>(null),[viewed,setViewed]=useState<ProviderReport|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const alive=useRef(true),generation=useRef(0),saving=useRef(false),apiRef=useRef(api);apiRef.current=api;
  useEffect(()=>{alive.current=true;void apiRef.current<ProviderReport[]>('/v1/provider-catalog').then(value=>{if(alive.current)setCatalog(value);}).catch(()=>{if(alive.current)setError('モデル設定の一覧を取得できませんでした。');});return()=>{alive.current=false;generation.current++;};},[]);
  const latest=Math.max(0,...catalog.filter(r=>r.profile.id===selected).map(r=>r.profile.version),...versions.map(r=>r.profile.version));
  const nextVersion=selected?latest+1:1, capabilities=inferred(form);
  function field<K extends keyof ModelProfile>(name:K,value:ModelProfile[K]){setForm(previous=>({...previous,[name]:value}));}
  function capability<K extends keyof ProviderCapabilities>(name:K,value:ProviderCapabilities[K]){setForm(previous=>({...previous,capabilities:{...inferred(previous),[name]:value}}));}
  function reset(){generation.current++;setSelected(null);setVersions([]);setViewed(null);setForm(defaults());setError('');setNotice('');}
  async function load(id:string,version?:number){
    const attempt=++generation.current;setBusy(true);setError('');setNotice('');
    try{const items=await api<ProviderReport[]>(`/v1/model-profiles/${encodeURIComponent(id)}/versions`),record=items.find(r=>r.profile.version===(version??items[0]?.profile.version));
      if(!record)throw new Error('PROFILE_NOT_FOUND');if(!alive.current||attempt!==generation.current)return;
      setSelected(id);setVersions(items);setViewed(record);setForm({...record.profile,capabilities:inferred(record.profile)});
    }catch(cause){if(alive.current&&attempt===generation.current)setError(cause instanceof Error?cause.message:'取得できませんでした。');}
    finally{if(alive.current&&attempt===generation.current)setBusy(false);}
  }
  async function save(){
    if(saving.current)return;saving.current=true;setBusy(true);setError('');setNotice('');const attempt=++generation.current;
    try{
      const {baseUrl,apiKeyEnv,limitGroup,...rest}=form;
      const parsed=ModelProfileSchema.safeParse({...rest,version:nextVersion,...baseUrl?{baseUrl}:{},...apiKeyEnv?{apiKeyEnv}:{},...limitGroup?{limitGroup}:{}});
      if(!parsed.success)throw new Error('入力を確認してください：'+parsed.error.issues.map(i=>i.path.join('.')+': '+i.message).join(' / '));
      const saved=await api<ModelProfile>('/v1/model-profiles',parsed.data);
      if(!alive.current||attempt!==generation.current)return;
      setSelected(saved.id);setForm(saved);setNotice(`保存済み：${saved.id} v${saved.version}。既存セッションの送信先・固定版は変更していません。`);
      const [items,all]=await Promise.all([api<ProviderReport[]>(`/v1/model-profiles/${saved.id}/versions`),api<ProviderReport[]>('/v1/provider-catalog')]);
      if(!alive.current||attempt!==generation.current)return;setVersions(items);setCatalog(all);setViewed(items.find(r=>r.profile.version===saved.version)??null);await refresh();
    }catch(cause){if(alive.current&&attempt===generation.current)setError(cause instanceof Error?cause.message:'保存できませんでした。');}
    finally{saving.current=false;if(alive.current&&attempt===generation.current)setBusy(false);}
  }
  return <section className="provider-manager" aria-label="モデル設定の編集">
    <p className="muted">Ollama Native / OpenAI互換 Chat Completionsを設定します。保存だけでは推論・接続試験・既存セッションへの適用を行いません。</p>
    <div className="provider-catalog">{catalog.map(item=><button type="button" disabled={busy} key={item.profile.id} aria-pressed={selected===item.profile.id} onClick={()=>void load(item.profile.id)}><strong>{item.profile.id}</strong><small>{item.profile.provider} · {item.profile.model} · v{item.profile.version}</small></button>)}</div>
    <button type="button" disabled={busy} onClick={reset}>新規モデル設定</button>
    {error&&<p className="error-inline" role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {selected&&<div className="provider-version">
      <label>モデル設定の参照版<select aria-label="モデル設定の参照版" disabled={busy} value={viewed?.profile.version??''} onChange={e=>void load(selected,Number(e.target.value))}>{versions.map(r=><option key={r.profile.version} value={r.profile.version}>v{r.profile.version} · {r.profile.model}</option>)}</select></label>
      <p>最新 v{latest} ／ 次の保存 v{nextVersion}</p>
      {viewed&&<><p>定義ハッシュ：<code>{viewed.hash}</code></p><p>同時枠・障害共有scope：<code>{viewed.health.scope}</code></p><p>接続状態：{viewed.health.state} ／ Core上の認証参照：{viewed.credentialConfiguredOnCore?'設定あり／認証不要':'未設定または読取不可'}</p><small>これはCoreでの確認です。別Workerへの鍵配置や実サービスの対応を確認した結果ではありません。実行時はセッションの診断に固定版と実送信先を表示します。</small></>}
    </div>}
    <form onSubmit={e=>{e.preventDefault();void save();}}><fieldset disabled={busy}>
      <legend>新しい版として保存</legend>
      <label>モデル設定ID<input aria-label="モデル設定ID" required maxLength={64} pattern="[a-zA-Z0-9][a-zA-Z0-9_.-]*" disabled={selected!==null} value={form.id} onChange={e=>field('id',e.target.value)}/></label>
      <label>API方式<select aria-label="API方式" value={form.provider} onChange={e=>{const provider=e.target.value as ModelProfile['provider'];setForm(p=>({...p,provider,capabilities:{...inferred(p),outputTokenParameter:provider==='ollama'?'num_predict':'max_tokens'}}));}}><option value="openai">OpenAI互換 Chat Completions</option><option value="ollama">Ollama Native</option><option value="mock">模擬モデル（制御試験用）</option></select></label>
      <label>モデルID<input aria-label="モデルID" required maxLength={200} value={form.model} onChange={e=>field('model',e.target.value)}/></label>
      <label>Base URL<input aria-label="Base URL" type="url" required={form.provider!=='mock'} value={form.baseUrl??''} onChange={e=>field('baseUrl',e.target.value)} placeholder="APIのベースURL"/></label>
      <small>Ollamaは /api、OpenAI互換は /v1 など、利用するサービスのベースパスを指定します。URLに認証情報を入れないでください。</small>
      <label>APIキーの環境変数参照<input aria-label="APIキーの環境変数参照" maxLength={128} value={form.apiKeyEnv??''} onChange={e=>field('apiKeyEnv',e.target.value)} pattern="[A-Z][A-Z0-9_]*"/></label>
      <small>鍵の値は入力・表示・保存しません。Worker側へこの名前の環境変数、または同名_FILEの秘密ファイル参照を配置してください。同じ鍵を共有する設定は同じ参照名を使用します。</small>
      <label className="check-field"><input type="checkbox" checked={form.authRequired} onChange={e=>field('authRequired',e.target.checked)}/>認証を必須にする</label>
      <label className="check-field"><input type="checkbox" checked={form.allowLocalHttp} onChange={e=>field('allowLocalHttp',e.target.checked)}/>ローカルHTTPを明示的に許可</label>
      <label>JSON出力方式<select aria-label="JSON出力方式" value={form.jsonMode} onChange={e=>field('jsonMode',e.target.value as ModelProfile['jsonMode'])}><option value="none">通常テキスト内JSON</option><option value="json">JSON object</option><option value="schema">Strict schema</option></select></label>
      <fieldset className="provider-capabilities"><legend>Provider能力（設定者の申告）</legend>
        {(['none','json','schema'] as const).map(mode=><label className="check-field" key={mode}><input type="checkbox" checked={capabilities.jsonModes.includes(mode)} onChange={e=>capability('jsonModes',e.target.checked?[...capabilities.jsonModes,mode]:capabilities.jsonModes.filter(v=>v!==mode))}/>{mode} を対応済みと設定</label>)}
        <label>出力tokenパラメータ<select aria-label="出力tokenパラメータ" value={capabilities.outputTokenParameter} onChange={e=>capability('outputTokenParameter',e.target.value as ProviderCapabilities['outputTokenParameter'])}><option value="max_tokens">max_tokens</option><option value="max_completion_tokens">max_completion_tokens</option><option value="num_predict">num_predict</option></select></label>
        <label className="check-field"><input type="checkbox" checked={capabilities.temperatureSupported} onChange={e=>capability('temperatureSupported',e.target.checked)}/>temperatureを送信する</label>
        <label>usage対応<select aria-label="usage対応" value={capabilities.usage} onChange={e=>capability('usage',e.target.value as ProviderCapabilities['usage'])}><option value="unknown">未確認</option><option value="reported">報告あり</option><option value="unavailable">報告なし</option></select></label>
        <small>未申告の旧版と明示した能力を区別します。実APIの対応・精度をこの設定だけで検証済みにはしません。</small>
      </fieldset>
      <label>最大出力token<input aria-label="最大出力token" type="number" min={128} max={4096} required value={form.maxOutputTokens} onChange={e=>field('maxOutputTokens',Number(e.target.value))}/></label>
      <label>temperature<input aria-label="temperature" type="number" min={0} max={2} step={0.1} required value={form.temperature} onChange={e=>field('temperature',Number(e.target.value))}/></label>
      <label>共有制限グループ（任意）<input aria-label="共有制限グループ（任意）" value={form.limitGroup??''} maxLength={64} onChange={e=>field('limitGroup',e.target.value)}/></label>
      <small>未指定ならAPI方式・ベースURL・認証参照で分離します。同じグループ名は鍵が違っても同時枠と障害状態を共有します。</small>
      <label>最大同時呼出し<input aria-label="最大同時呼出し" type="number" min={1} max={32} required value={form.maxConcurrent} onChange={e=>field('maxConcurrent',Number(e.target.value))}/></label>
      <label>連続失敗の閾値<input aria-label="連続失敗の閾値" type="number" min={1} max={10} required value={form.failureThreshold} onChange={e=>field('failureThreshold',Number(e.target.value))}/></label>
      <label>障害待機時間（ms）<input aria-label="障害待機時間（ms）" type="number" min={1000} max={3600000} required value={form.circuitCooldownMs} onChange={e=>field('circuitCooldownMs',Number(e.target.value))}/></label>
      <button type="submit" className="primary">モデル設定を新しい版で保存</button>
    </fieldset></form>
  </section>;
}
