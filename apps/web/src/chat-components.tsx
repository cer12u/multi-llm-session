import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { PublicAgent, PublicMessage } from '../../../packages/contracts/index.js';
import { avatarTone, dayKey, dayLabel, initial, isGrouped, preview, shouldSendOnEnter, timeLabel } from './chat-model.js';

export function Icon({ name }: { name: 'menu' | 'plus' | 'search' | 'close' | 'send' | 'reply' | 'settings' | 'users' | 'down' }) {
  const paths: Record<string, string> = {
    menu: 'M4 6h16M4 12h16M4 18h16', plus: 'M12 5v14M5 12h14', search: 'm16 16 5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
    close: 'm6 6 12 12M6 18 18 6', send: 'm3 3 18 9-18 9 4-9-4-9Zm4 9h14', reply: 'M9 10H5l5-5M5 10l5 5M5 10h9a5 5 0 0 1 5 5v4',
    settings: 'M4 7h16M4 17h16M9 4v6M15 14v6', users: 'M15 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0M5 21v-2a7 7 0 0 1 14 0v2M18 4a3 3 0 0 1 0 6M21 14v5', down: 'm6 9 6 6 6-6',
  };
  return <svg className="icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name]} /></svg>;
}
export function Avatar({ id, name, small = false }: { id: string; name: string; small?: boolean }) {
  return <span aria-hidden="true" className={`avatar ${avatarTone(id)}${small ? ' small' : ''}`}>{initial(name)}</span>;
}
export function Dialog({ title, children, close }: { title: string; children: React.ReactNode; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null), label = useId();
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => { dialog.close(); }; }, []);
  return <dialog ref={ref} className="modal" aria-labelledby={label} onCancel={event => { event.preventDefault(); close(); }}>
    <div className="modal-heading"><h2 id={label}>{title}</h2><button className="icon-button" aria-label="閉じる" onClick={close}><Icon name="close" /></button></div>
    <div className="modal-body">{children}</div>
  </dialog>;
}
export type Draft = { text: string; addressedTo: string };
export const emptyDraft: Draft = { text: '', addressedTo: '' };
export function Composer({ draft, change, send, pending, agents, thread = false, title }: {
  draft: Draft; change: (draft: Draft) => void; send: () => void; pending: boolean; agents: PublicAgent[]; thread?: boolean; title: string;
}) {
  const composing = useRef(false), ref = useRef<HTMLTextAreaElement>(null), hint = useId();
  useEffect(() => { if (!pending && document.activeElement === document.body) ref.current?.focus(); }, [pending]);
  return <form className="composer" aria-label={thread ? 'スレッドの入力' : 'メッセージの入力'} onSubmit={event => { event.preventDefault(); if (!pending && draft.text.trim() && !composing.current) send(); }}>
    <label className="sr-only" htmlFor={hint + '-text'}>{thread ? 'スレッドへ返信' : '発言'}</label>
    <textarea ref={ref} id={hint + '-text'} value={draft.text} onChange={event => change({ ...draft, text: event.target.value })} rows={3} maxLength={8000}
      placeholder={thread ? 'この発言への返信を書く' : `# ${title} にメッセージを送信`} disabled={pending} aria-describedby={hint}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
      onKeyDown={event => { if (shouldSendOnEnter({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing, keyCode: event.keyCode }, composing.current)) { event.preventDefault(); if (!pending && draft.text.trim()) send(); } }} />
    <div className="composer-tools"><label className="address-label"><span>@</span><span className="sr-only">{thread ? '返信の宛先' : '宛先'}</span><select value={draft.addressedTo} disabled={pending} onChange={event => change({ ...draft, addressedTo: event.target.value })}>
      <option value="">全員</option>{agents.filter(agent => agent.enabled).map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
    </select></label><button type="submit" className="send-button" disabled={pending || !draft.text.trim()} aria-label={thread ? '返信を送信' : '送信'}><Icon name="send" /><span>{pending ? '送信中' : '送信'}</span></button></div>
    <div className="composer-hint" id={hint}>Enter で送信・Shift + Enter で改行<span>下書きはこのタブ内で保持</span></div>
  </form>;
}
export function MessageRow({ message, parent, grouped = false, replies = 0, reply, jump, remove, highlighted = false, timeline = false }: {
  message: PublicMessage; parent?: PublicMessage; grouped?: boolean; replies?: number; reply?: () => void; jump?: (id: string) => void; remove?: () => void; highlighted?: boolean; timeline?: boolean;
}) {
  return <article className={`message-row ${message.authorId ? 'bot' : 'human'}${grouped ? ' grouped' : ''}${highlighted ? ' highlighted' : ''}`}
    id={timeline ? `message-${message.id}` : undefined} data-message-id={message.id} data-author={message.authorId ?? 'human'} aria-label={`${message.authorName} ${timeLabel(message.createdAt)}`}>
    <div className="message-avatar">{!grouped ? <Avatar id={message.characterId ?? 'human'} name={message.authorName} /> : <time className="grouped-time">{timeLabel(message.createdAt)}</time>}</div>
    <div className="message-content">{!grouped && <div className="message-byline"><strong>{message.authorName}</strong>{message.authorId && <span className="agent-tag">Agent</span>}<time dateTime={new Date(message.createdAt).toISOString()} title={new Date(message.createdAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}>{timeLabel(message.createdAt)}</time></div>}
      {message.replyTo && <button className="reply-preview" disabled={!parent || !jump} onClick={() => jump?.(message.replyTo!)}><Icon name="reply" /><span>{parent ? `${parent.authorName}：${preview(parent)}` : '表示範囲より前の発言への返信'}</span></button>}
      <p className={message.deleted ? 'deleted-text' : ''}>{message.deleted ? '（削除済み）' : message.text}</p>
      {replies > 0 && <button className="reply-count" onClick={reply}>{replies} 件の返信<span>返信を表示 →</span></button>}
    </div>
    {(reply || remove) && <div className="message-actions">{reply && <button title="返信を表示・入力" aria-label="返信" onClick={reply}><Icon name="reply" /></button>}{remove && !message.deleted && <button className="delete-action" aria-label="発言を削除" onClick={remove}>削除</button>}</div>}
  </article>;
}
export type ScrollPosition = { top: number; atBottom: boolean };
export function Timeline({ sessionId, title, messages, reply, remove, jumpId, positions }: {
  sessionId: string; title: string; messages: PublicMessage[]; reply: (id: string) => void; remove?: (message: PublicMessage) => void; jumpId: string | null; positions: Map<string, ScrollPosition>;
}) {
  const ref = useRef<HTMLDivElement>(null), atBottom = useRef(true), last = useRef<{ session: string; id?: string }>({ session: '' });
  const [newMessages, setNewMessages] = useState(0), [highlight, setHighlight] = useState<string | null>(null);
  const map = new Map(messages.map(message => [message.id, message]));
  const replies = new Map<string, number>();
  for (const message of messages) if (message.replyTo) replies.set(message.replyTo, (replies.get(message.replyTo) ?? 0) + 1);
  function bottom() { const el = ref.current; if (!el) return; el.scrollTop = el.scrollHeight; atBottom.current = true; positions.set(sessionId, { top: el.scrollTop, atBottom: true }); setNewMessages(0); }
  function jump(id: string) { const node = ref.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`); if (node) { node.scrollIntoView({ block: 'center', behavior: 'auto' }); setHighlight(id); } }
  useLayoutEffect(() => {
    const el = ref.current!;
    if (last.current.session !== sessionId) {
      const stored = positions.get(sessionId); atBottom.current = stored?.atBottom ?? true;
      el.scrollTop = atBottom.current ? el.scrollHeight : stored?.top ?? 0;
      setNewMessages(0);
    } else if (last.current.id !== messages.at(-1)?.id) {
      if (atBottom.current) bottom();
      else { const index = messages.findIndex(message => message.id === last.current.id); setNewMessages(count => count + (index < 0 ? 1 : messages.length - index - 1)); }
    }
    last.current = { session: sessionId, id: messages.at(-1)?.id };
  }, [messages, sessionId]);
  useEffect(() => { if (jumpId) jump(jumpId); }, [jumpId]);
  useEffect(() => { if (!highlight) return; const timer = setTimeout(() => setHighlight(null), 1800); return () => clearTimeout(timer); }, [highlight]);
  return <div className="timeline-wrap"><div ref={ref} className="timeline" role="log" aria-label="会話履歴" aria-live="polite" aria-relevant="additions text" onScroll={() => {
    const el = ref.current!; atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    positions.set(sessionId, { top: el.scrollTop, atBottom: atBottom.current }); if (atBottom.current) setNewMessages(0);
  }}>
    <section className="channel-intro"><span className="channel-hash">#</span><h2>{title}</h2><p>ここがこのセッションの会話スペースです。話題を送るか、Agentの会話を観察してください。</p></section>
    {messages.length >= 200 && <p className="history-limit">直近200件を表示しています。以前の発言は検索で参照できます。</p>}
    {messages.map((message, index) => <React.Fragment key={message.id}>
      {(!index || dayKey(messages[index - 1].createdAt) !== dayKey(message.createdAt)) && <div className="day-divider"><span>{dayLabel(message.createdAt)}<small> JST</small></span></div>}
      {index > 0 && messages[index - 1].episode !== message.episode && <div className="episode-divider">会話を再開 · エピソード {message.episode}</div>}
      <MessageRow message={message} parent={map.get(message.replyTo ?? '')} grouped={isGrouped(messages[index - 1], message)} replies={replies.get(message.id) ?? 0}
        reply={() => reply(message.id)} jump={jump} remove={remove ? () => remove(message) : undefined} highlighted={highlight === message.id} timeline />
    </React.Fragment>)}
    {!messages.length && <div className="first-message">まだ発言はありません。最初の話題を入力できます。</div>}
  </div>{newMessages > 0 && <button className="new-messages" onClick={bottom}><Icon name="down" />新着 {newMessages} 件 · 最新へ</button>}</div>;
}
