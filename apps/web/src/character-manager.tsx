import React, { useEffect, useRef, useState } from 'react';
import { CharacterSchema, type Character, type PublicAgent } from '../../../packages/contracts/index.js';
import './character-manager.css';

type Api = <T>(path: string, body?: unknown, key?: string) => Promise<T>;
type Record = { character: Character; hash: string };
type Version = { id: string; version: number; name: string; hash: string };
const blank = (): Character => ({ schemaVersion: 1, id: '', version: 1, name: '', persona: '', presentationRef: null });

export function CharacterManager({ characters, participants, api, refresh }: {
  characters: Character[]; participants: PublicAgent[]; api: Api; refresh: () => Promise<void>;
}) {
  const [form, setForm] = useState<Character>(blank), [selected, setSelected] = useState<string | null>(null);
  const [versions, setVersions] = useState<Version[]>([]), [viewed, setViewed] = useState<Record | null>(null);
  const [json, setJson] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const generation = useRef(0), alive = useRef(true), saving = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; }; }, []);
  const latest = Math.max(0, ...versions.map(v => v.version), ...characters.filter(c => c.id === selected).map(c => c.version));
  const saveVersion = selected ? latest + 1 : 1;
  const pinned = participants.filter(a => a.characterId === selected);
  function reset() { generation.current++; setSelected(null); setVersions([]); setViewed(null); setForm(blank()); setError(''); setNotice(''); }
  async function load(id: string, version?: number) {
    const attempt = ++generation.current; setBusy(true); setError(''); setNotice('');
    try {
      const items = await api<Version[]>(`/v1/characters/${encodeURIComponent(id)}/versions`);
      const record = await api<Record>(`/v1/characters/${encodeURIComponent(id)}/versions/${version ?? items[0].version}`);
      if (!alive.current || attempt !== generation.current) return;
      setSelected(id); setVersions(items); setViewed(record); setForm(record.character);
    } catch (cause) { if (alive.current && attempt === generation.current) setError(cause instanceof Error ? cause.message : '定義を取得できませんでした。'); }
    finally { if (alive.current && attempt === generation.current) setBusy(false); }
  }
  async function save(input: unknown) {
    if (saving.current) return; saving.current = true; setBusy(true); setError(''); setNotice('');
    const attempt = ++generation.current;
    try {
      const checked = CharacterSchema.safeParse(input);
      if (!checked.success) throw new Error('入力形式を確認してください。ID・名前・人格の必須項目、文字数、未知のフィールドを確認してください。');
      const record = await api<Record>('/v1/characters/import', checked.data);
      if (!alive.current || attempt !== generation.current) return;
      // Saving has succeeded even if a later list refresh fails. Keep its exact immutable version visible.
      setSelected(record.character.id); setForm(record.character); setViewed(record);
      const items = await api<Version[]>(`/v1/characters/${record.character.id}/versions`);
      if (!alive.current || attempt !== generation.current) return;
      setVersions(items); setJson(''); setNotice(`保存済み：${record.character.id} v${record.character.version}。既存セッションの定義は変更していません。`);
      await refresh();
    } catch (cause) { if (alive.current && attempt === generation.current) setError(cause instanceof Error ? cause.message : '保存できませんでした。'); }
    finally { saving.current = false; if (alive.current && attempt === generation.current) setBusy(false); }
  }
  async function download() {
    if (!viewed || busy) return; const ref = viewed.character, attempt = generation.current; setError('');
    try {
      const value = await api<Character>(`/v1/characters/${ref.id}/versions/${ref.version}/export`);
      if (!alive.current || attempt !== generation.current) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `character-${ref.id}-v${ref.version}.json`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { if (alive.current && attempt === generation.current) setError(cause instanceof Error ? cause.message : '出力できませんでした。'); }
  }
  return <section className="character-manager" aria-label="キャラクター編集">
    <p className="muted">定義は版ごとに保存します。新しい版は新規セッションで選ばれ、既存セッションには自動適用しません。人格・私有状態・モデル・表示は別の設定です。</p>
    <div className="character-catalog" aria-label="キャラクター一覧">{characters.map(c => <button type="button" disabled={busy} key={c.id} aria-pressed={selected === c.id} onClick={() => void load(c.id)}>
      <strong>{c.name}</strong><small>{c.id} · 最新 v{c.version}</small>
    </button>)}</div>
    <button type="button" disabled={busy} onClick={reset}>新規キャラクター</button>
    {error && <p role="alert" className="error-inline">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {selected && <div className="character-version">
      <label>参照する版<select disabled={busy} value={viewed?.character.version ?? ''} onChange={e => void load(selected, Number(e.target.value))}>
        {versions.map(v => <option value={v.version} key={v.version}>v{v.version} · {v.name}</option>)}
      </select></label>
      <p className="muted">最新 v{latest} ／ 参照中 v{viewed?.character.version} ／ 次の保存 v{saveVersion}</p>
      <p className="character-pinned">現在のセッション：{pinned.length ? pinned.map(a => `${a.name} は v${a.characterVersion} に固定`).join('、') : 'このキャラクターは参加していません'}</p>
      {viewed && <small className="definition-hash">定義ハッシュ：{viewed.hash}</small>}
      <button type="button" disabled={busy || !viewed} onClick={() => void download()}>参照中の版をエクスポート</button>
    </div>}
    <form onSubmit={e => { e.preventDefault(); void save({ ...form, version: saveVersion }); }}>
      <fieldset disabled={busy} className="character-fields"><legend>{selected ? '新しい版として編集' : 'キャラクターを作成'}</legend>
        <label>キャラクターID<input value={form.id} disabled={selected !== null} onChange={e => setForm(v => ({ ...v, id: e.target.value }))} required maxLength={64} pattern="[a-zA-Z0-9][a-zA-Z0-9_.-]*" /></label>
        <label>名前<input value={form.name} onChange={e => setForm(v => ({ ...v, name: e.target.value }))} required maxLength={80} /></label>
        <label>人格・話し方・背景<textarea rows={7} value={form.persona} onChange={e => setForm(v => ({ ...v, persona: e.target.value }))} required maxLength={6000} /></label>
        <label>表示参照（任意）<input value={form.presentationRef ?? ''} onChange={e => setForm(v => ({ ...v, presentationRef: e.target.value || null }))} maxLength={256} /></label>
        <small>表示参照は識別子として保存するだけで、URLやスクリプトを実行しません。未対応の参照は文字表示のままです。</small>
        <label>保存する版<input readOnly value={saveVersion} /></label>
        <button type="submit" className="primary">{busy ? '保存中' : '新しい版を保存'}</button>
      </fieldset>
    </form>
    <details><summary>JSONのインポート</summary><p className="muted">共有契約で検証し、既存の同じID・版を異なる内容で上書きする操作は拒否します。</p>
      <label>インポートJSON<textarea rows={6} value={json} onChange={e => setJson(e.target.value)} disabled={busy} maxLength={30000} /></label>
      <button type="button" disabled={busy || !json.trim()} onClick={() => {
        try { const parsed: unknown = JSON.parse(json); void save(parsed); } catch { setError('JSONを解析できませんでした。'); }
      }}>JSONをインポート</button>
    </details>
  </section>;
}
