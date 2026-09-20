import { describe, expect, it } from 'vitest';
import type { PublicMessage } from '../packages/contracts/index.js';
import { avatarTone, dayKey, initial, isGrouped, preview, rootMessageId, shouldSendOnEnter, threadMessages } from '../apps/web/src/chat-model.js';
const message = (id: string, overrides: Partial<PublicMessage> = {}): PublicMessage => ({ id, sessionId: 'session', revision: 1, authorId: 'agent-a', authorName: '葵', characterId: 'a', characterVersion: 1, text: '試験用の発言', act: 'comment', replyTo: null, addressedTo: [], deleted: false, episode: 1, createdAt: Date.parse('2026-09-20T01:00:00Z'), ...overrides });
describe('chat projections (not model conversation quality)', () => {
  it('groups only consecutive messages by the same author within the same day and episode', () => {
    const first = message('1');
    expect(isGrouped(first, message('2', { createdAt: first.createdAt + 60000 }))).toBe(true);
    for (const change of [{ authorId: 'b' }, { episode: 2 }, { replyTo: '1' }, { deleted: true }, { createdAt: first.createdAt + 6 * 60000 }]) expect(isGrouped(first, message('2', change))).toBe(false);
    expect(isGrouped(undefined, first)).toBe(false);
  });
  it('separates dates at midnight Japan time', () => {
    expect(dayKey(Date.parse('2026-09-20T14:59:59Z'))).toBe('2026-09-20');
    expect(dayKey(Date.parse('2026-09-20T15:00:00Z'))).toBe('2026-09-21');
  });
  it('projects nested replies without excluding them from the shared input history', () => {
    const history = [message('1'), message('2', { replyTo: '1' }), message('3'), message('4', { replyTo: '2' })];
    expect(rootMessageId(history, '4')).toBe('1');
    expect(threadMessages(history, '2').map(value => value.id)).toEqual(['1', '2', '4']);
    expect(history).toHaveLength(4);
  });
  it('handles a missing historical parent and a defensive cycle without hanging', () => {
    expect(rootMessageId([message('2', { replyTo: 'missing' })], '2')).toBe('2');
    const cycle = [message('1', { replyTo: '2' }), message('2', { replyTo: '1' })];
    expect(rootMessageId(cycle, '1')).toBe('1');
  });
  it('does not re-expose deleted content in quote previews', () => {
    expect(preview(message('1', { text: 'hidden', deleted: true }))).not.toContain('hidden');
    expect(preview(message('2', { text: '一行目\n二行目' }))).toBe('一行目 二行目');
  });
  it('keeps character avatar color stable across session instances', () => {
    expect(avatarTone('character-a')).toBe(avatarTone('character-a'));
    expect(avatarTone('character-a')).toMatch(/^tone-[0-5]$/);
    expect(initial('  葵')).toBe('葵'); expect(initial('')).toBe('?');
  });
  it('sends on Enter but not Shift+Enter or an IME confirmation', () => {
    expect(shouldSendOnEnter({ key: 'Enter', shiftKey: false })).toBe(true);
    expect(shouldSendOnEnter({ key: 'Enter', shiftKey: true })).toBe(false);
    expect(shouldSendOnEnter({ key: 'Enter', shiftKey: false, isComposing: true })).toBe(false);
    expect(shouldSendOnEnter({ key: 'Enter', shiftKey: false, keyCode: 229 })).toBe(false);
    expect(shouldSendOnEnter({ key: 'Enter', shiftKey: false }, true)).toBe(false);
    expect(shouldSendOnEnter({ key: 'a', shiftKey: false })).toBe(false);
  });
});
