import { ensure, type Context } from '../contracts/index.js';
import { hash } from '../domain/index.js';
import { characterOf, profileOf, type AgentRow, type RunRow, type Store } from '../storage-sqlite/index.js';

/** Current identity and membership, not volatile worker status or scheduling timestamps. */
export function identityCurrent(store:Store,agentId:string,context:Context):boolean {
  const agent=store.get<AgentRow>('SELECT * FROM agent_instances WHERE id=?',agentId);
  if(!agent||context.self.id!==agentId||!context.self.profileHash||
    context.self.profileHash!==hash(profileOf(agent))||hash(context.self.character)!==hash(characterOf(agent)))return false;
  const expected=context.participants.map(p=>[p.id,p.characterId,p.characterVersion]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
  const current=store.all<AgentRow>('SELECT * FROM agent_instances WHERE session_id=? AND enabled=1',agent.session_id)
    .map(a=>{const c=characterOf(a);return [a.id,c.id,c.version];}).sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
  return JSON.stringify(expected)===JSON.stringify(current);
}

/** Full candidate text is the persisted carry between chunks; a bare KEEP cannot carry new interpretation. */
export function requireReviewReconstruction(context:Context,decision:string):void {
  ensure(context.coverage?.complete!==false||decision!=='KEEP',422,'REVIEW_RECONSTRUCTION_REQUIRED');
}

/** A legacy unbound candidate must be reviewed before publication, never silently grandfathered in. */
export function candidateIdentityCurrent(store:Store,candidateId:string,agentId:string):boolean {
  const last=store.get<RunRow>("SELECT * FROM runs WHERE candidate_id=? AND agent_id=? AND state='DONE' AND kind IN ('draft','review') ORDER BY rowid DESC LIMIT 1",candidateId,agentId);
  return !!last&&identityCurrent(store,agentId,JSON.parse(last.context_json) as Context);
}
