import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { CharacterSchema, ModelProfileSchema, SettingsSchema, ensure, type Character, type ModelProfile, type Settings } from '../contracts/index.js';

export const defaultCharacters: Character[] = [
  { schemaVersion: 1, id: 'sora', version: 1, name: 'ソラ', persona: '好奇心が強く、身近な出来事から疑問を見つける。相手の話をよく聞く。何でも質問で締める必要はない。日本語で自然に話す。', presentationRef: null },
  { schemaVersion: 1, id: 'nagi', version: 1, name: 'ナギ', persona: '落ち着いていて具体的な体験や条件を大切にする。結論を急がず、相づちや沈黙も選ぶ。いつも反論する役割ではない。日本語で自然に話す。', presentationRef: null },
  { schemaVersion: 1, id: 'rin', version: 1, name: 'リン', persona: '連想とユーモアを好み、話題同士の意外なつながりを見つける。他人の発言を尊重し、無理に会話を続けない。日本語で自然に話す。', presentationRef: null },
];
const FileConfigSchema = z.object({
  characters: z.array(CharacterSchema).min(3).max(100).optional(),
  profiles: z.array(ModelProfileSchema).min(1).max(30).optional(),
  workerSlots: z.array(z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/), tokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/) }).strict()).min(3).max(16).optional(),
  feeds: z.array(z.object({ id: z.string().regex(/^[a-z0-9-]{1,64}$/), url: z.string().url(), intervalMs: z.number().int().min(60000).default(1800000) }).strict()).max(20).default([]),
  sessionDefaults: SettingsSchema.optional(),
}).strict();
export type Config = {
  dbPath: string; host: string; port: number; publicOrigin: string; adminToken: string; viewerToken: string|null;
  workerTokens: Record<string,string>; profiles: ModelProfile[]; characters: Character[]; defaults: Settings;
  allowLive: boolean; maxRunning: number; maxConcurrentProvider: number; restartPolicy: 'resume'|'paused';
  feeds: {id:string;url:string;intervalMs:number}[];
};
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const file = FileConfigSchema.parse(env.APP_CONFIG ? JSON.parse(readFileSync(env.APP_CONFIG, 'utf8')) : {});
  const allowLive = env.ALLOW_LIVE_MODELS === '1';
  let profiles = file.profiles ?? [ModelProfileSchema.parse({ id: 'mock', provider: 'mock', model: 'deterministic-demo-v1' })];
  if (env.MODEL_PROVIDER && env.MODEL_PROVIDER !== 'mock') profiles = [...profiles, ModelProfileSchema.parse({
    id: 'live', provider: env.MODEL_PROVIDER, model: env.MODEL_NAME, baseUrl: env.MODEL_BASE_URL,
    apiKeyEnv: 'LLM_API_KEY', jsonMode: env.MODEL_JSON_MODE ?? 'none', allowLocalHttp: env.ALLOW_LOCAL_HTTP === '1',
    authRequired: env.MODEL_AUTH_REQUIRED !== '0',
  })];
  for (const p of profiles) {
    if (p.provider === 'mock') continue;
    ensure(allowLive, 500, 'LIVE_DISABLED'); ensure(p.baseUrl, 500, 'MISSING_MODEL_URL');
    const url = new URL(p.baseUrl);
    ensure(!url.username && !url.password && !url.search && !url.hash, 500, 'UNSAFE_MODEL_URL');
    const local = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
    ensure(url.protocol === 'https:' || (p.allowLocalHttp && local && url.protocol === 'http:'), 500, 'MODEL_HTTPS_REQUIRED');
    ensure(!p.authRequired || (p.apiKeyEnv && env[p.apiKeyEnv]), 500, 'MISSING_MODEL_KEY');
  }
  ensure(new Set(profiles.map(p=>p.id)).size === profiles.length, 500, 'DUPLICATE_PROFILE');
  const slots = file.workerSlots ?? ['a','b','c'].map(x=>({ id:'worker-'+x, tokenEnv:'WORKER_'+x.toUpperCase()+'_TOKEN' }));
  const workerTokens: Record<string,string> = {};
  for (const slot of slots) {
    const key = env[slot.tokenEnv]; ensure(key && key.length >= 24, 500, 'MISSING_WORKER_TOKEN_' + slot.id);
    ensure(!Object.values(workerTokens).includes(key) && !workerTokens[slot.id], 500, 'DUPLICATE_WORKER_IDENTITY');
    workerTokens[slot.id] = key;
  }
  const adminToken = env.ADMIN_TOKEN ?? ''; ensure(adminToken.length >= 24, 500, 'ADMIN_TOKEN_REQUIRED');
  ensure(!Object.values(workerTokens).includes(adminToken), 500, 'SEPARATE_ADMIN_AND_WORKER_KEYS');
  const viewerToken = env.VIEWER_TOKEN || null;
  ensure(!viewerToken || (viewerToken.length >= 24 && viewerToken !== adminToken && !Object.values(workerTokens).includes(viewerToken)), 500, 'INVALID_VIEWER_TOKEN');
  const port = Number(env.PORT ?? 3000); ensure(Number.isInteger(port) && port >= 0 && port <= 65535, 500, 'INVALID_PORT');
  const publicOrigin = env.PUBLIC_ORIGIN ?? `http://127.0.0.1:${port}`;
  ensure(new URL(publicOrigin).origin === publicOrigin, 500, 'PUBLIC_ORIGIN_MUST_BE_ORIGIN');
  for (const feed of file.feeds) {
    const u = new URL(feed.url); ensure(u.protocol === 'https:' && !u.username && !u.password, 500, 'FEED_HTTPS_REQUIRED');
  }
  return { dbPath: env.DB_PATH ?? 'data/conversation.sqlite', host: env.APP_BIND ?? '127.0.0.1', port, publicOrigin,
    adminToken, viewerToken, workerTokens, profiles, characters: file.characters ?? defaultCharacters,
    defaults: file.sessionDefaults ?? SettingsSchema.parse({}), allowLive, maxRunning: 1, maxConcurrentProvider: 3,
    restartPolicy: env.RESTART_POLICY === 'paused' ? 'paused' : 'resume', feeds: file.feeds };
}
