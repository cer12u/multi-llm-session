import type { PublicMessage } from '../../../packages/contracts/index.js';

export const lifecycleLabels: Record<string, string> = { DRAFT: '開始前', RUNNING: '会話中', PAUSED: '一時停止', ENDED: '終了' };
export const activityLabels: Record<string, string> = { ACTIVE: '進行中', QUIET: '静かに待機中', DEGRADED: 'API・Workerの状態を確認してください', BUDGET_PAUSED: '実行上限で停止' };
export const agentLabels: Record<string, string> = { thinking: '参加を検討中', reviewing: '発言候補を再確認中', remembering: '記憶を整理中', listening: '会話を聞いています', idle: '待機中', ready: '発言待ち', deferred: '発言を保留中', error: 'エラー', disabled: '停止中' };

export function avatarTone(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return `tone-${hash % 6}`;
}
export function initial(name: string): string { return Array.from(name.trim())[0] ?? '?'; }
export function dayKey(time: number): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(time);
}
export function dayLabel(time: number): string {
  return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'long', day: 'numeric', weekday: 'long' }).format(time);
}
export function timeLabel(time: number): string {
  return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false }).format(time);
}
export function isGrouped(previous: PublicMessage | undefined, current: PublicMessage): boolean {
  return !!previous && !previous.deleted && !current.deleted && !current.replyTo && !previous.replyTo &&
    previous.authorId === current.authorId && previous.authorName === current.authorName &&
    previous.episode === current.episode && dayKey(previous.createdAt) === dayKey(current.createdAt) &&
    current.createdAt >= previous.createdAt && current.createdAt - previous.createdAt < 5 * 60000;
}
/** A thread is only a projection of the public session. It never creates a private agent context. */
export function rootMessageId(messages: PublicMessage[], id: string): string {
  const map = new Map(messages.map(message => [message.id, message]));
  const seen = new Set<string>();
  let current = id;
  while (!seen.has(current)) {
    seen.add(current);
    const parent = map.get(current)?.replyTo;
    if (!parent || !map.has(parent)) return current;
    current = parent;
  }
  return id; // Defensive handling of invalid/cyclic imported data.
}
export function threadMessages(messages: PublicMessage[], id: string): PublicMessage[] {
  const root = rootMessageId(messages, id);
  return messages.filter(message => rootMessageId(messages, message.id) === root);
}
export function shouldSendOnEnter(event: { key: string; shiftKey: boolean; isComposing?: boolean; keyCode?: number }, composing = false): boolean {
  return event.key === 'Enter' && !event.shiftKey && !event.isComposing && !composing && event.keyCode !== 229;
}
export function preview(message: PublicMessage): string {
  return message.deleted ? '（削除済みの発言）' : message.text.replace(/\s+/g, ' ').slice(0, 100);
}
