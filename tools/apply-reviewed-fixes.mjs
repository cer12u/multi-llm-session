import {readFileSync,writeFileSync,unlinkSync} from 'node:fs';
const edits=[
 ['apps/cli/cluster.ts','const workerEnv={...env,CORE_URL:base','const workerEnv:NodeJS.ProcessEnv={...env,CORE_URL:base'],
 ['apps/cli/lab.ts','const env={...process.env,APP_CONFIG:configPath','const env:NodeJS.ProcessEnv={...process.env,APP_CONFIG:configPath'],
 ['apps/core/server.ts',"const id=randomBytes(32).toString('base64url'),login={role,csrf:","const id=randomBytes(32).toString('base64url');const login:Login={role,csrf:"],
 ['apps/web/src/main.tsx','body?:unknown,idem=crypto.randomUUID()','body?:unknown,idem:string=crypto.randomUUID()'],
 ['apps/core/server.ts',"ensure(header(req,'host')===new URL(config.publicOrigin).host,403,'INVALID_HOST');","ensure(header(req,'host')===new URL(config.publicOrigin).host || (req.url.startsWith('/v1/worker/') && Object.values(config.workerTokens).some(t=>equal(header(req,'authorization'),'Bearer '+t))),403,'INVALID_HOST');"],
 ['packages/session-service/index.ts',"'SELECT * FROM messages WHERE session_id=? ORDER BY revision DESC LIMIT ?',s.id,st.contextMessages","'SELECT * FROM messages WHERE session_id=? ORDER BY rowid DESC LIMIT ?',s.id,st.contextMessages"],
 ['packages/session-service/index.ts',"'SELECT * FROM messages WHERE session_id=? AND deleted=0 ORDER BY revision DESC LIMIT 1',id","'SELECT * FROM messages WHERE session_id=? AND deleted=0 ORDER BY rowid DESC LIMIT 1',id"],
 ['packages/session-service/index.ts',"'SELECT * FROM messages WHERE session_id=? ORDER BY revision DESC LIMIT 200',id","'SELECT * FROM messages WHERE session_id=? ORDER BY rowid DESC LIMIT 200',id"],
 ['packages/session-service/index.ts',"'SELECT * FROM messages WHERE session_id=? ORDER BY revision',id","'SELECT * FROM messages WHERE session_id=? ORDER BY rowid',id"],
 ['packages/session-service/index.ts',"this.store.run('DELETE FROM messages_fts WHERE message_id=?',messageId);","this.store.run('DELETE FROM messages_fts WHERE message_id=?',messageId);\n      this.store.run('DELETE FROM memories WHERE EXISTS (SELECT 1 FROM json_each(memories.sources_json) WHERE value=?)',messageId);"],
];
for(const [file,from,to] of edits){const text=readFileSync(file,'utf8');if(text.split(from).length!==2)throw new Error('Expected unique reviewed replacement in '+file);writeFileSync(file,text.replace(from,to));}
unlinkSync('.github/workflows/apply-reviewed-fixes.yml');unlinkSync('tools/apply-reviewed-fixes.mjs');
