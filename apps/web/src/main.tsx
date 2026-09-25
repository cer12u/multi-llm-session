import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Character, PublicMessage, PublicSession, Settings, Snapshot } from '../../../packages/contracts/index.js';
import { subscribeSession } from './event-stream.js';
import { activityLabels, agentLabels, lifecycleLabels, preview, timeLabel } from './chat-model.js';
import { Avatar, Dialog, Icon, MessageRow, Timeline, type ScrollPosition } from './chat-components.js';
import { ArchiveSession } from './archive-session.js';
import './archive.css';
import { PersistentComposer, useDurableDrafts } from './persistent-composer.js';
import './drafts.css';
import { CharacterManager } from './character-manager.js';
import { ProviderManager } from './provider-manager.js';
import { SourceManager } from './source-manager.js';
import { OperationsPanel } from './operations-panel.js';
import './style.css';

type Auth = { role: 'operator' | 'viewer'; csrf: string };
type Capabilities = { profiles: { id: string; provider: string; model: string }[]; slots: string[]; defaults: Settings; liveEnabled: boolean };
type Panel = 'thread' | 'members' | 'search' | 'settings' | 'diagnostics' | 'source' | null;
type Modal = 'create' | 'characters' | 'providers' | 'end' | 'delete' | null;
const panelTitles: Record<Exclude<Panel, null>, string> = { thread: 'スレッド', members: '参加者', search: '会話を検索', settings: 'セッション設定', diagnostics: '管理者向け診断', source: '資料を共有' };
const errorMessages: Record<string, string> = { AUTH_REQUIRED: 'ログインし直してください。', INVALID_LOGIN: 'トークンを確認してください。', READ_ONLY: '閲覧者は投稿できません。', SESSION_NOT_RUNNING: 'セッションの状態を確認してください。', LIVE_DISABLED: '実モデルはまだ有効になっていません。', VALIDATION_ERROR: '入力の形式や上限を確認してください。', IDEMPOTENCY_CONFLICT: '再送する内容が元の操作と一致しません。' };

function App() {
  const [auth, setAuth] = useState<Auth | null>(null), [token, setToken] = useState(''), [error, setError] = useState('');
  const [sessions, setSessions] = useState<PublicSession[]>([]), [selected, setSelected] = useState<string | null>(null), [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [characters, setCharacters] = useState<Character[]>([]), [caps, setCaps] = useState<Capabilities | null>(null);
  const [modal, setModal] = useState<Modal>(null), [panel, setPanel] = useState<Panel>(null), [sidebarOpen, setSidebarOpen] = useState(false);
  const [title, setTitle] = useState('自由な会話'), [members, setMembers] = useState<{ characterId: string; profileId: string; slot: string }[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null), [jumpId, setJumpId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [, renderArchive] = useState(0);
  const archives = useRef(new Map<string, ArchiveSession>());
  const initialLink = useRef({ session: new URLSearchParams(location.search).get('session'), message: new URLSearchParams(location.search).get('message'), used: false });
  const [settingsText, setSettingsText] = useState('');
  const [diagnostic, setDiagnostic] = useState<unknown>(null), [connection, setConnection] = useState('接続準備中'), [saving, setSaving] = useState(false), [deleting, setDeleting] = useState<PublicMessage | null>(null);
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const authRef = useRef(auth); authRef.current = auth;
  const authEpoch = useRef(0), currentSnapshot = useRef<Snapshot | null>(null);
  const positions = useRef(new Map<string, ScrollPosition>());
  const operator = auth?.role === 'operator';
  const vault = useDurableDrafts(operator, api, resetAuth);
  const session = snapshot?.session;
  const mainDraftKey = selected ?? '';
  const archive = selected ? archives.current.get(selected) : undefined;
  const results = archive?.searchStarted ? archive.results : null;
  const searchBusy = archive?.searchBusy ?? false;
  const root = archive?.threadRoot ?? null;
  const thread = archive?.thread ?? [];
  const replyDraftKey = selected && root ? `${selected}/reply/${root}` : '';
  function archiveFor(id: string): ArchiveSession {
    let value = archives.current.get(id);
    if (!value) { value = new ArchiveSession(id, api, () => renderArchive(n => n + 1)); archives.current.set(id, value); }
    return value;
  }
  function resetAuth() {
    for (const value of archives.current.values()) value.dispose(); archives.current.clear();
    authEpoch.current++; selectedRef.current = null; currentSnapshot.current = null;
    setAuth(null); setSelected(null); setSnapshot(null); setSessions([]); setCaps(null); setCharacters([]);
    positions.current.clear(); setModal(null); setPanel(null); setError('');
  }
  async function api<T>(path: string, body?: unknown, idem: string = crypto.randomUUID()): Promise<T> {
    const epoch = authEpoch.current;
    let response: Response | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
          headers: body === undefined ? {} : { 'content-type': 'application/json', 'x-csrf-token': authRef.current?.csrf ?? '', 'idempotency-key': idem }, body: body === undefined ? undefined : JSON.stringify(body) });
        break;
      } catch (cause) { if (attempt) throw cause; }
    }
    if (!response) throw new Error('接続を確認してください。下書きは保持しています。');
    const value = await response.json();
    if (!response.ok) { if (response.status === 401 && epoch === authEpoch.current) resetAuth(); throw Object.assign(new Error(errorMessages[value.code] ?? value.code ?? `HTTP ${response.status}`), { status: response.status, code: value.code }); }
    return value as T;
  }
  function run(operation: () => Promise<void>) {
    const epoch = authEpoch.current; setError('');
    void operation().catch(cause => { if (epoch === authEpoch.current) setError(cause instanceof Error ? cause.message : '操作に失敗しました。'); });
  }
  function publish(next: Snapshot) {
    if (!authRef.current || selectedRef.current !== next.session.id) return;
    const previous = currentSnapshot.current;
    if (previous?.session.id === next.session.id && Number(previous.cursor.split(':').at(-1)) > Number(next.cursor.split(':').at(-1))) return;
    currentSnapshot.current = next; setSnapshot(next);
    const cache = archiveFor(next.session.id);
    void cache.synchronize(next).then(async () => {
      const link = initialLink.current;
      if (!link.used && link.message && link.session === next.session.id) {
        link.used = true;
        if (await cache.locate(link.message) && selectedRef.current === next.session.id) setJumpId(link.message);
      }
    }).catch(cause => { if (selectedRef.current === next.session.id) setError(cause instanceof Error ? cause.message : '原文を取得できませんでした。'); });
    setSessions(values => values.map(value => value.id === next.session.id ? next.session : value));
  }
  async function refresh(id = selectedRef.current) {
    const epoch = authEpoch.current;
    const list = await api<PublicSession[]>('/v1/sessions');
    if (epoch !== authEpoch.current) return;
    setSessions(list);
    if (id) { const next = await api<Snapshot>(`/v1/sessions/${id}/snapshot`); if (epoch === authEpoch.current) publish(next); }
  }
  function selectSession(id: string) {
    selectedRef.current = id; currentSnapshot.current = null;
    const url = new URL(location.href); if (url.searchParams.get('session') !== id) url.searchParams.delete('message');
    url.searchParams.set('session', id); history.replaceState(null, '', url);
    setSelected(id); setSnapshot(null); setPanel(null); setThreadId(null); setJumpId(null); setSearch(''); archiveFor(id).changeQuery(); setDiagnostic(null); setSidebarOpen(false);
  }
  async function refreshCharacters() {
    const epoch = authEpoch.current;
    const definitions = await api<Character[]>('/v1/characters');
    if (epoch === authEpoch.current) setCharacters(definitions);
  }
  async function refreshProfiles() {
    const epoch = authEpoch.current;
    const capabilities = await api<Capabilities>('/v1/capabilities');
    if (epoch === authEpoch.current) setCaps(capabilities);
  }
  async function initialize() {
    const epoch = authEpoch.current;
    const [cs, cp, ss] = await Promise.all([api<Character[]>('/v1/characters'), api<Capabilities>('/v1/capabilities'), api<PublicSession[]>('/v1/sessions')]);
    if (epoch !== authEpoch.current) return;
    setCharacters(cs); setCaps(cp); setSessions(ss);
    setMembers(cp.slots.slice(0, 3).map((slot, index) => ({ slot, characterId: cs[index % cs.length]?.id ?? '', profileId: cp.profiles.find(profile => profile.provider === 'mock')?.id ?? cp.profiles[0]?.id ?? '' })));
    if (!selectedRef.current && ss.length) selectSession(ss.find(s => s.id === initialLink.current.session)?.id ?? ss[0].id);
  }
  useEffect(() => { let cancelled = false; void fetch('/v1/auth/me').then(async response => { if (response.ok) { const value = await response.json(); if (!cancelled) setAuth(value); } }).catch(() => {}); return () => { cancelled = true; }; }, []);
  useEffect(() => { if (auth) run(initialize); }, [auth?.role]);
  useEffect(() => {
    if (!auth || !selected) return;
    const epoch = authEpoch.current;
    setConnection('接続準備中');
    return subscribeSession(() => api<Snapshot>(`/v1/sessions/${selected}/snapshot`), next => { if (epoch === authEpoch.current) publish(next); }, setConnection, { onEvent: event => archiveFor(selected).event(event) });
  }, [selected, auth?.role]);
  useEffect(() => {
    if (!auth) return;
    let closed = false; const epoch = authEpoch.current;
    const timer = setInterval(() => { void api<PublicSession[]>('/v1/sessions').then(list => { if (!closed && epoch ===authEpoch.current) setSessions(list); }).catch(() => {}); }, 5000);
    return () => { closed = true; clearInterval(timer); };
  }, [auth?.role]);
  useEffect(() => {
    if (panel !== 'diagnostics' || !selected || !operator) return;
    let closed = false;
    const update = () => { void api<unknown>(`/v1/sessions/${selected}/diagnostics`).then(value => { if (!closed) setDiagnostic(value); }).catch(() => {}); };
    update(); const timer = setInterval(update, 1500); return () => { closed = true; clearInterval(timer); };
  }, [panel, selected, operator]);
  useEffect(() => { const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !modal) { setPanel(null); setSidebarOpen(false); } }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey); }, [modal]);
  async function logout() {
    let warning='';
    try { await vault?.clear(); } catch { warning='端末の下書きを削除できませんでした。共有端末ではブラウザーのサイトデータを削除してください。'; }
    try { await api('/v1/auth/logout', {}); } finally { resetAuth(); if(warning)setError(warning); }
  }
  async function control(action: 'start' | 'pause' | 'resume' | 'end') {
    const id = selectedRef.current; if (!id) return;
    await api(`/v1/sessions/${id}/${action}`, {}); await refresh(id);
  }
  function openPanel(next: Exclude<Panel, null>) {
    if (next === 'settings' && snapshot) setSettingsText(JSON.stringify(snapshot.session.settings, null, 2));
    setPanel(value => value === next ? null : next); setSidebarOpen(false);
  }
  function openThread(id: string) { setThreadId(id); setPanel('thread'); setSidebarOpen(false); if (selected) void archiveFor(selected).openThread(id); }
  async function jump(id: string) {
    const sessionId = selectedRef.current; if (!sessionId) return;
    setPanel(null); setJumpId(null);
    if (await archiveFor(sessionId).locate(id) && selectedRef.current === sessionId) {
      const url = new URL(location.href); url.searchParams.set('session', sessionId); url.searchParams.set('message', id); history.replaceState(null, '', url);
      requestAnimationFrame(() => setJumpId(id));
    }
  }
  async function exportSession() {
    const id = selectedRef.current; if (!id) return;
    const value = await api(`/v1/sessions/${id}/export`), url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `session-${id}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const createForm = caps && <form onSubmit={event => { event.preventDefault(); if (saving) return; setSaving(true); run(async () => {
    try { const created = await api<{ id: string }>('/v1/sessions', { title, participants: members, settings: caps.defaults }); await refresh(null); selectSession(created.id); setModal(null); } finally { setSaving(false); }
  }); }}>
    <p className="form-description">3名以上のキャラクターを選んで、会話スペースを作成します。作成だけでは推論を開始しません。</p>
    <label>セッション名<input autoFocus value={title} onChange={event => setTitle(event.target.value)} required maxLength={120} /></label>
    <div className="member-fields">{members.map((member, index) => <fieldset key={member.slot}><legend>参加者 {index + 1}</legend><label>キャラクター<select value={member.characterId} onChange={event => setMembers(values => values.map((value, n) => n === index ? { ...value, characterId: event.target.value } : value))}>{characters.map(character => <option key={character.id} value={character.id}>{character.name} · v{character.version}</option>)}</select></label><label>モデル<select value={member.profileId} onChange={event => setMembers(values => values.map((value, n) => n === index ? { ...value, profileId: event.target.value } : value))}>{caps.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.provider === 'mock' ? '模擬モデル（制御試験用）' : profile.model}</option>)}</select></label></fieldset>)}</div>
    <div className="form-actions">{members.length < caps.slots.length && <button type="button" onClick={() => setMembers(values => [...values, { slot: caps.slots[values.length], characterId: characters[values.length % characters.length].id, profileId: caps.profiles[0].id }])}>参加者を追加</button>}{members.length > 3 && <button type="button" onClick={() => setMembers(values => values.slice(0, -1))}>最後の参加者を外す</button>}<button className="primary" type="submit" disabled={saving || members.length < 3}>{saving ? '作成中' : 'セッションを作成'}</button></div>
  </form>;
  if (!auth) return <main className="login-page"><section className="login-card"><span className="brand-mark">S</span><p className="eyebrow">MULTI LLM SESSION</p><h1>会話のスペースへ。</h1><p>キャラクター同士のやり取りを、ひとつのチャットで。</p><form onSubmit={event => { event.preventDefault(); run(async () => {
    const response = await fetch('/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
    const value = await response.json(); if (!response.ok) throw new Error(errorMessages[value.code] ?? value.code); authEpoch.current++; setAuth(value); setToken('');
  }); }}><label>ログイントークン<input autoComplete="current-password" type="password" value={token} onChange={event => setToken(event.target.value)} required /></label><button type="submit" className="primary">ログイン</button></form>{error && <p role="alert" className="error-inline">{error}</p>}<small>起動時のターミナル、または管理者から受け取ったトークンを入力してください。</small><p className="login-note">実LLMの会話成立・品質は未検証です。初期設定は模擬モデルです。</p></section></main>;
  return <div className="chat-app"><header className="workspace-bar"><button className="icon-button mobile-menu" aria-label="セッション一覧を開く" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(value => !value)}><Icon name="menu" /></button><div className="workspace-brand"><span className="brand-mark compact">S</span><strong>Session Lab</strong></div><button className="workspace-search" disabled={!selected} onClick={() => openPanel('search')}><Icon name="search" /><span>このセッションを検索</span></button><span className="workspace-role">{operator ? '管理者' : '閲覧者'}</span></header>
    {error && !modal && <div className="error-banner" role="alert"><span>{error}</span><button className="icon-button" aria-label="エラーを閉じる" onClick={() => setError('')}><Icon name="close" /></button></div>}
    <div className="chat-shell">{sidebarOpen && <button className="sidebar-scrim" aria-label="セッション一覧を閉じる" onClick={() => setSidebarOpen(false)} />}
      <aside className={`session-sidebar${sidebarOpen ? ' open' : ''}`} aria-label="ワークスペース"><div className="sidebar-heading"><div><strong>会話ワークスペース</strong><small>独立したキャラクターのセッション</small></div>{operator && <button className="icon-button" aria-label="新しいセッション" title="新しいセッション" onClick={() => { setModal('create'); setSidebarOpen(false); }} disabled={!caps}><Icon name="plus" /></button>}</div>
        <div className="channel-list-heading"><span>セッション</span><button className="text-button" onClick={() => run(() => refresh())}>更新</button></div>
        <nav aria-label="セッション一覧">{sessions.map(item => <button key={item.id} className={`channel-item${selected === item.id ? ' selected' : ''}`} aria-current={selected === item.id ? 'page' : undefined} onClick={() => { if (selected !== item.id) selectSession(item.id); else setSidebarOpen(false); }}>
          <span className="hash">#</span><span className="channel-copy"><strong>{item.title}</strong><small><span className={`state-dot ${item.lifecycle.toLowerCase()}`} />{lifecycleLabels[item.lifecycle]} · {item.mode === 'mock' ? '模擬' : '実モデル'}{vault?.draft(item.id).text ? ' · 下書き' : ''}</small></span><span className="post-count" title="Agentの累計発言数">{item.botMessages}</span>
        </button>)}</nav>{!sessions.length && <p className="sidebar-empty">まだセッションがありません。</p>}
        {operator && <button className="new-channel" onClick={() => { setModal('create'); setSidebarOpen(false); }} disabled={!caps}><Icon name="plus" />セッションを追加</button>}
        <div className="sidebar-footer">{operator && <><button onClick={() => { setModal('characters'); setSidebarOpen(false); }}><Icon name="users" />キャラクターを管理</button><button onClick={() => { setModal('providers'); setSidebarOpen(false); }}><Icon name="settings" />モデルを管理</button></>}<button onClick={() => run(logout)}>ログアウト</button><small>ログアウトでこの端末の下書き・再送状態を削除します。</small></div>
      </aside>
      <div className={`session-workspace${panel ? ' with-panel' : ''}`}><main className="chat-main">{snapshot && session ? <>
        <header className="channel-header"><div className="channel-title"><h1><span>#</span> {session.title}</h1><p><span className={`state-dot ${session.lifecycle.toLowerCase()}`} />{lifecycleLabels[session.lifecycle]}<span className="connection"> · {connection}</span></p></div><div className="channel-header-actions"><button className="member-button" aria-label="参加者" title="参加者" onClick={() => openPanel('members')}><span className="avatar-stack">{snapshot.agents.slice(0, 3).map(agent => <Avatar key={agent.id} id={agent.characterId} name={agent.name} small />)}</span><span>{snapshot.agents.length}</span></button>{operator && <>{session.lifecycle === 'DRAFT' && <button className="primary compact-button" onClick={() => run(() => control('start'))}>開始</button>}{session.lifecycle === 'RUNNING' && <button className="compact-button" onClick={() => run(() => control('pause'))}>一時停止</button>}{session.lifecycle === 'PAUSED' && <button className="primary compact-button" onClick={() => run(() => control('resume'))}>再開</button>}</>}<button className="icon-button" aria-label="セッション設定" onClick={() => openPanel('settings')}><Icon name="settings" /></button></div></header>
        <div className={`mode-strip ${session.mode}`}><span className="mode-badge">{session.mode === 'mock' ? 'MOCK · 模擬応答' : 'LIVE · 実LLM'}</span><span>{session.mode === 'mock' ? '定型応答による動作確認です。実LLMの会話成立・品質を示すものではありません。' : '実モデル接続中です。会話の成立・品質は別途評価が必要です。'}</span></div>
        <div className="archive-toolbar">{archive?.historyCursor ? <button disabled={archive.historyBusy} onClick={() => run(() => archive.loadOlder())}>{archive.historyBusy ? '履歴を取得中' : '以前の発言を読み込む'}</button> : <span>履歴の先頭です</span>}{archive?.historyError && <><span role="alert">{archive.historyError}</span><button onClick={() => run(() => archive.resynchronize())}>履歴を再同期</button></>}</div>
        <Timeline key={session.id} sessionId={session.id} title={session.title} messages={archive?.messages ?? snapshot.messages} reply={openThread} navigate={id => run(() => jump(id))} remove={operator && session.lifecycle !== 'ENDED' ? message => { setDeleting(message); setModal('delete'); } : undefined} jumpId={jumpId} positions={positions.current} />
        <div className="conversation-status" role="status">{session.stopReason ? `停止理由：${session.stopReason}` : session.lifecycle !== 'RUNNING' ? (session.lifecycle === 'DRAFT' ? '開始前です。話題を先に入力できます。' : session.lifecycle === 'PAUSED' ? 'Agentは一時停止中です。人間の発言は追加できます。' : 'このセッションは終了しました。履歴は引き続き参照できます。') : snapshot.agents.filter(agent => ['thinking', 'reviewing', 'remembering'].includes(agent.status)).map(agent => `${agent.name}：${agentLabels[agent.status]}`).join(' ／ ') || activityLabels[session.activity]}</div>
        <div className="composer-dock">{operator && (session.lifecycle !== 'ENDED' || !!vault?.draft(mainDraftKey).text || vault?.status(mainDraftKey).unknown) ? <PersistentComposer key={mainDraftKey} controller={vault} draftKey={mainDraftKey} title={session.title} agents={snapshot.agents} perform={run} afterSend={() => refresh(session.id)} lockedReason={session.lifecycle === 'ENDED' ? '終了したセッションでは送信できません。' : undefined} /> : <div className="read-only-note">{operator ? '終了した会話は読み取り専用です。' : '閲覧モード · メッセージの投稿や会話制御はできません。'}</div>}</div>
      </> : <div className="workspace-empty"><span className="large-hash">#</span><h1>{selected ? '会話を読み込んでいます' : '新しい会話をはじめる'}</h1><p>{selected ? connection : '左側からセッションを選ぶか、キャラクターを選んで会話スペースを作成します。'}</p>{!selected && operator && <button className="primary" disabled={!caps} onClick={() => setModal('create')}>新しいセッション</button>}<small>現在は実験用アプリです。UIの動作確認と、実LLMの会話検証は別です。</small></div>}</main>
      {panel && snapshot && session && <aside className="detail-panel" aria-label={panelTitles[panel]}><div className="panel-heading"><h2>{panelTitles[panel]}</h2><button className="icon-button" aria-label="パネルを閉じる" onClick={() => setPanel(null)}><Icon name="close" /></button></div>
        {panel === 'thread' ? <><p className="panel-context"># {session.title}<small>同じセッションの公開会話です。返信も全Agentに共有されます。</small></p><div className="thread-messages">{thread.map(message => <MessageRow key={message.id} message={message} />)}{archive?.threadBusy && <p role="status">返信を取得中</p>}{archive?.threadError && <p role="alert">{archive.threadError}</p>}{archive?.threadCursor && <button disabled={archive.threadBusy} onClick={() => void archive.openThread(root ?? threadId!, true)}>返信の続きを読み込む</button>}{!archive?.threadBusy && !archive?.threadCursor && <p className="muted">返信の末尾です。</p>}</div>{operator && root && thread.length > 0 && (session.lifecycle !== 'ENDED' || !!vault?.draft(replyDraftKey).text || vault?.status(replyDraftKey).unknown) && <div className="thread-composer"><PersistentComposer key={replyDraftKey} controller={vault} draftKey={replyDraftKey} thread title={session.title} agents={snapshot.agents} perform={run} afterSend={() => refresh(session.id)} lockedReason={thread[0].deleted ? '返信元は削除済みです。' : session.lifecycle === 'ENDED' ? '終了したセッションでは送信できません。' : undefined} /></div>}</> : <div className="panel-content">
          {panel === 'members' && <><p className="muted">キャラクター定義と、今回のセッションの参加Agentは別に保持されます。</p>{snapshot.agents.map(agent => <div className="member-row" key={agent.id}><Avatar id={agent.characterId} name={agent.name} /><div><strong>{agent.name}</strong><small>{agentLabels[agent.enabled ? agent.status : 'disabled'] ?? agent.status}</small><small>定義 v{agent.characterVersion} · {agent.profileId}</small></div>{operator && session.lifecycle !== 'ENDED' && <button className="text-button" onClick={() => run(async () => { await api(`/v1/sessions/${session.id}/members`, { agentId: agent.id, enabled: !agent.enabled }); await refresh(session.id); })}>{agent.enabled ? '停止' : '有効化'}</button>}</div>)}</>}
          {panel === 'search' && <><form className="search-form" onSubmit={event => { event.preventDefault(); if (archive) void archive.search(search); }}>
            <label>検索語<input autoFocus value={search} onChange={event => { setSearch(event.target.value); archive?.changeQuery(); }} required maxLength={200} placeholder="このセッションの発言を検索" /></label><button className="primary" disabled={searchBusy}>{searchBusy ? '検索中' : '検索'}</button></form>
            <p className="muted">保存されている原文を50件ずつ検索します。</p>{archive?.searchError && <><p role="alert">{archive.searchError}</p><button onClick={() => void archive.search(search)}>先頭から再検索</button></>}
            {results && <p className="result-count">{results.length} 件を取得</p>}{results?.map(message => <div className="search-result" key={message.id}><div><strong>{message.authorName}</strong><time>{timeLabel(message.createdAt)}</time></div><p>{message.text}</p><a href={`/?session=${encodeURIComponent(session.id)}&message=${encodeURIComponent(message.id)}`} onClick={event => { event.preventDefault(); run(() => jump(message.id)); }}>会話内で表示 →</a><button className="text-button" onClick={() => openThread(message.id)}>返信を表示</button></div>)}
            {archive?.searchCursor && <button disabled={searchBusy} onClick={() => void archive.search(archive.searchQuery, true)}>検索の続きを読み込む</button>}{results && !archive?.searchCursor && !searchBusy && <p>検索結果の末尾です。</p>}
          </>}
          {panel === 'settings' && <><div className="session-facts"><span>実行状態</span><strong>{lifecycleLabels[session.lifecycle]}</strong><span>推論呼び出し</span><strong>{session.calls} / {session.settings.maxCalls}</strong><span>Agentの発言</span><strong>{session.botMessages} / {session.settings.maxMessages}</strong><span>履歴 revision</span><strong>{session.revision}</strong></div>{operator && <><div className="panel-actions"><button onClick={() => openPanel('source')}>資料を共有</button><button onClick={() => run(exportSession)}>会話を出力</button><button onClick={() => openPanel('diagnostics')}>診断</button></div><details><summary>実行上限・待機時間の詳細設定</summary><p className="muted">開始前または一時停止中だけ変更できます。</p><label className="sr-only" htmlFor="execution-settings">実行設定JSON</label><textarea id="execution-settings" className="settings-editor" value={settingsText} onChange={event => setSettingsText(event.target.value)} /><button disabled={!['DRAFT', 'PAUSED'].includes(session.lifecycle)} onClick={() => run(async () => { await api(`/v1/sessions/${session.id}/settings`, JSON.parse(settingsText)); await refresh(session.id); })}>設定を保存</button></details>{session.lifecycle !== 'ENDED' && <button className="danger-button end-session" onClick={() => setModal('end')}>セッションを終了</button>}</>}<p className="muted">模擬モデルのテスト結果は、実LLM同士の任意会話が成立したことを証明しません。</p></>}
          {panel === 'diagnostics' && operator && <><OperationsPanel key={session.id} sessionId={session.id} api={api} refresh={() => refresh(session.id)} /><details><summary>内部実行記録（管理者限定）</summary><p className="muted">通常の会話表示や他のAgentには未投稿候補を配信しません。</p><pre>{JSON.stringify(diagnostic, null, 2)}</pre></details></>}
          {panel === 'source' && operator && <SourceManager key={session.id} session={session} agents={snapshot.agents} api={api} />}
        </div>}
      </aside>}
      </div>
    </div>
    {modal === 'create' && <Dialog error={error} title="新しいセッション" close={() => setModal(null)}>{createForm}</Dialog>}
    {modal === 'characters' && operator && <Dialog error={error} title="キャラクターを管理" close={() => setModal(null)}><CharacterManager characters={characters} participants={snapshot?.agents ?? []} api={api} refresh={refreshCharacters} /></Dialog>}
    {modal === 'providers' && operator && <Dialog title="モデルを管理" close={() => setModal(null)}><ProviderManager api={api} refresh={refreshProfiles} /></Dialog>}
    {modal === 'end' && session && <Dialog error={error} title="セッションを終了しますか？" close={() => setModal(null)}><p>「{session.title}」のAgentを停止し、会話を読み取り専用にします。再開したい場合は終了ではなく一時停止を使ってください。</p><div className="form-actions"><button onClick={() => setModal(null)}>キャンセル</button><button className="danger-button" onClick={() => run(async () => { await control('end'); setModal(null); })}>終了する</button></div></Dialog>}
    {modal === 'delete' && deleting && <Dialog error={error} title="この発言を削除しますか？" close={() => setModal(null)}><blockquote>{preview(deleting)}</blockquote><p className="muted">公開履歴から本文を削除します。過去の内部実行記録やバックアップからの完全消去ではありません。</p><div className="form-actions"><button onClick={() => setModal(null)}>キャンセル</button><button className="danger-button" onClick={() => run(async () => { await api(`/v1/sessions/${deleting.sessionId}/messages/${deleting.id}`, { text: null }); await refresh(deleting.sessionId); setModal(null); setDeleting(null); })}>削除する</button></div></Dialog>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<App />);
