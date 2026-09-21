import { z } from 'zod';
import { CharacterSchema, Slug, ensure, type Character } from '../contracts/index.js';

export const CharacterRefSchema = z.object({ id: Slug, version: z.number().int().positive() }).strict();
export type CharacterRef = z.infer<typeof CharacterRefSchema>;
/** Acquisition is separate from session identity, inference and presentation. */
export interface CharacterProvider { load(ref: CharacterRef): Character | Promise<Character>; }

export function checkCharacter(ref: CharacterRef, input: unknown): Character {
  const expected = CharacterRefSchema.parse(ref), character = CharacterSchema.parse(input);
  ensure(character.id === expected.id && character.version === expected.version, 422, 'CHARACTER_REF_MISMATCH');
  return character;
}
export async function resolveCharacter(provider: CharacterProvider, ref: CharacterRef): Promise<Character> {
  const requested = CharacterRefSchema.parse(ref);
  return checkCharacter(requested, await provider.load(requested));
}
/** A local JSON definition provider; no remote URL or executable asset is evaluated. */
export class LocalCharacterProvider implements CharacterProvider {
  private readonly entries = new Map<string, Character>();
  constructor(definitions: unknown[]) {
    for (const input of definitions) {
      const character = CharacterSchema.parse(input), key = `${character.id}:${character.version}`;
      ensure(!this.entries.has(key), 422, 'DUPLICATE_CHARACTER_VERSION'); this.entries.set(key, character);
    }
  }
  load(ref: CharacterRef): Character {
    const parsed = CharacterRefSchema.parse(ref), character = this.entries.get(`${parsed.id}:${parsed.version}`);
    ensure(character, 404, 'CHARACTER_VERSION_NOT_FOUND');
    return structuredClone(character);
  }
}
