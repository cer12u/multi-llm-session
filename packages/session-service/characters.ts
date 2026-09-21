import { CharacterRefSchema, checkCharacter, resolveCharacter, type CharacterProvider, type CharacterRef } from '../characters/index.js';
import { ensure, type Character } from '../contracts/index.js';
import { hash } from '../domain/index.js';
import type { SessionService } from './index.js';

export type CharacterRecord = { character: Character; hash: string };
/** Persist only validated immutable definitions; sessions continue to use their frozen snapshots. */
export class CharacterCatalog implements CharacterProvider {
  constructor(private readonly service: Pick<SessionService, 'store' | 'putCharacter'>) {}
  versions(id: string): {id:string;version:number;name:string;hash:string}[] {
    CharacterRefSchema.parse({id,version:1});
    const rows = this.service.store.all<{version:number;definition:string;hash:string}>('SELECT version,definition,hash FROM characters WHERE id=? ORDER BY version DESC', id);
    ensure(rows.length, 404, 'CHARACTER_NOT_FOUND');
    return rows.map(row => ({id,version:row.version,name:checkCharacter({id,version:row.version},JSON.parse(row.definition)).name,hash:row.hash}));
  }
  get(ref: CharacterRef): CharacterRecord {
    const parsed = CharacterRefSchema.parse(ref);
    const row = this.service.store.get<{definition:string;hash:string}>('SELECT definition,hash FROM characters WHERE id=? AND version=?', parsed.id, parsed.version);
    ensure(row, 404, 'CHARACTER_VERSION_NOT_FOUND');
    const character = checkCharacter(parsed, JSON.parse(row.definition));
    ensure(hash(character) === row.hash, 409, 'CHARACTER_DEFINITION_CORRUPT');
    return {character,hash:row.hash};
  }
  load(ref: CharacterRef): Character { return this.get(ref).character; }
  async import(provider: CharacterProvider, ref: CharacterRef): Promise<CharacterRecord> {
    // A future remote provider may perform I/O here, never while a SQLite write lock is held.
    const character = await resolveCharacter(provider, ref);
    return this.service.store.tx(() => {
      this.service.putCharacter(character);
      return this.get(ref);
    });
  }
}
