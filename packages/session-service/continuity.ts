import { randomUUID } from 'node:crypto';
import { CharacterSchema, ModelProfileSchema, ensure, type ModelProfile } from '../contracts/index.js';
import type { MemberCatalog, MemberChange, SessionContinuity } from '../contracts/session.js';
import { hash } from '../domain/index.js';
import { characterOf, profileOf, settingsOf, type AgentRow, type SessionRow, type Store } from '../storage-sqlite/index.js';
import { providerScope } from '../provider-state/index.js';
import { validateProfileUrl } from '../config/credentials.js';
import type { Config } from '../config/index.js';
import type { SessionService } from './index.js';

export function memberCatalog(service: SessionService): MemberCatalog {
  return service.store.tx(() => ({
    characters: service.store.all<{ definition: string }>('SELECT definition FROM characters ORDER BY id,version DESC')
      .map(row => { const c = CharacterSchema.parse(JSON.parse(row.definition)); return { id: c.id, version: c.version, name: c.name }; }),
    profiles: service.store.all<{ definition: string }>('SELECT definition FROM model_profiles ORDER BY id,version DESC')
      .map(row => { const p = ModelProfileSchema.parse(JSON.parse(row.definition)); return { id: p.id, version: p.version, model: p.model, provider: p.provider }; }),
    slots: Object.keys(service.config.workerTokens),
  }));
}
export function continuity(service: SessionService, id: string): SessionContinuity {
  return service.store.tx(() => {
    const s = service.session(id), members = service.agents(id).map(a => {
      const c = characterOf(a), p = profileOf(a);
      return { agent: service.publicAgent(a), joinedAt: a.joined_at ?? s.created_at, retiredAt: a.retired_at ?? null,
        character: { id: c.id, version: c.version }, profile: { id: p.id, version: p.version } };
    });
    const present = members.filter(m => m.retiredAt === null);
    return { schemaVersion: 1, sessionId: id, epoch: s.epoch, lifecycle: s.lifecycle, members,
      counts: { present: present.length, enabled: present.filter(m => m.agent.enabled).length, online: present.filter(m => m.agent.enabled && m.agent.workerOnline).length },
      episodes: service.store.all<{ number: number; started_at: number; closed_at: number | null; from_sequence: number; through_sequence: number; origin: string }>(
        'SELECT * FROM session_episodes WHERE session_id=? ORDER BY number', id).map(e => ({ number: e.number, startedAt: e.started_at,
          closedAt: e.closed_at, fromSequence: e.from_sequence, throughSequence: e.through_sequence, origin: e.origin })),
      copyPolicy: 'new-session-new-identities-no-history-or-private-copy' };
  });
}

/** Invoked only by the authorized SessionService receipt transaction; never exposes or copies another identity's memory. */
export function applyMemberChange(store: Store, config: Config, session: SessionRow, command: MemberChange['change'], now: number): { agentId: string; retiredId?: string } {
  ensure(store.db.inTransaction, 500, 'MEMBERSHIP_TRANSACTION_REQUIRED');
  const existing = 'agentId' in command ? store.get<AgentRow>('SELECT * FROM agent_instances WHERE id=?', command.agentId) : undefined;
  if ('agentId' in command) { ensure(existing?.session_id === session.id, 403, 'AGENT_SESSION_MISMATCH'); ensure(existing.retired_at == null, 409, 'AGENT_RETIRED'); }
  let character: ReturnType<typeof CharacterSchema.parse> | undefined, profile: ModelProfile | undefined;
  if ('character' in command) {
    const c = store.get<{ definition: string; hash: string }>('SELECT definition,hash FROM characters WHERE id=? AND version=?', command.character.id, command.character.version);
    const p = store.get<{ definition: string; hash: string }>('SELECT definition,hash FROM model_profiles WHERE id=? AND version=?', command.profile.id, command.profile.version);
    ensure(c && p, 404, 'DEFINITION_VERSION_NOT_FOUND');
    character = CharacterSchema.parse(JSON.parse(c.definition)); profile = ModelProfileSchema.parse(JSON.parse(p.definition));
    ensure(hash(character) === c.hash && hash(profile) === p.hash, 409, 'DEFINITION_HASH_MISMATCH'); validateProfileUrl(profile);
    ensure(profile.provider === 'mock' || config.allowLive, 403, 'LIVE_DISABLED');
    const policy = (value: ModelProfile) => JSON.stringify([value.maxConcurrent, value.failureThreshold, value.circuitCooldownMs]);
    for (const other of store.all<AgentRow>("SELECT a.* FROM agent_instances a JOIN sessions s ON s.id=a.session_id WHERE a.retired_at IS NULL AND s.lifecycle!='ENDED'")) {
      if (other.id === existing?.id) continue;
      const frozen = profileOf(other); ensure(providerScope(profile) !== providerScope(frozen) || policy(profile) === policy(frozen), 422, 'ACTIVE_PROVIDER_POLICY_CONFLICT');
    }
  }
  function retire(a: AgentRow) {
    store.run("UPDATE agent_instances SET retired_at=?,enabled=0,state='retired',deferral_json=NULL,pending_since=NULL,due_at=NULL WHERE id=?", now, a.id);
    store.run("UPDATE agent_agenda SET status='CANCELLED',ended_at=?,reason='OWNER_RETIRED' WHERE agent_id=? AND status IN ('PENDING','TRIGGERED')", now, a.id);
    store.run('DELETE FROM agent_agenda_bindings WHERE agent_id=?', a.id);
  }
  if (command.action === 'set_enabled') {
    store.run('UPDATE agent_instances SET enabled=?,state=? WHERE id=?', command.enabled ? 1 : 0, command.enabled ? 'paused' : 'disabled', existing!.id);
    return { agentId: existing!.id };
  }
  if (command.action === 'retire') { retire(existing!); return { agentId: existing!.id, retiredId: existing!.id }; }
  if (command.action === 'apply') {
    ensure(character!.id === characterOf(existing!).id, 422, 'REPLACE_REQUIRED_FOR_DIFFERENT_CHARACTER');
    store.run('UPDATE agent_instances SET character_json=?,profile_json=? WHERE id=?', JSON.stringify(character), JSON.stringify(profile), existing!.id);
    return { agentId: existing!.id };
  }
  const slot = command.action === 'add' ? command.slot : existing!.slot;
  ensure(config.workerTokens[slot], 422, 'UNKNOWN_WORKER_SLOT');
  if (command.action === 'replace') retire(existing!);
  const count = store.get<{ n: number }>('SELECT COUNT(*) n FROM agent_instances WHERE session_id=? AND retired_at IS NULL', session.id)!.n;
  ensure(count < 16, 422, 'PARTICIPANT_LIMIT');
  ensure(!store.get('SELECT id FROM agent_instances WHERE session_id=? AND slot=? AND retired_at IS NULL', session.id, slot), 409, 'WORKER_SLOT_OCCUPIED');
  const id = randomUUID();
  store.run('INSERT INTO agent_instances(id,session_id,slot,character_json,profile_json,next_self_at,joined_at) VALUES(?,?,?,?,?,?,?)',
    id, session.id, slot, JSON.stringify(character), JSON.stringify(profile), now + settingsOf(session).selfWakeMinMs, now);
  store.run('INSERT INTO agent_private_states(agent_id,updated_at) VALUES(?,?)', id, now);
  store.run('INSERT INTO agent_input_cursors(agent_id) VALUES(?)', id);
  return { agentId: id, ...(command.action === 'replace' ? { retiredId: existing!.id } : {}) };
}
