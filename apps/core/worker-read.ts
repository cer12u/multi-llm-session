import {ensure} from '../../packages/contracts/index.js';
import type {SessionService} from '../../packages/session-service/index.js';

/** A reusable Worker slot is not an identity shared by every Agent that ever occupied it.
 * Normal inference uses run-bound LOOKUP; legacy Agent read routes must resolve to its current valid run.
 */
export function authorizeWorkerAgentRead(service:SessionService,slot:string,agentId:string):string {
  const agent=service.agent(agentId);
  ensure(agent.slot===slot&&agent.retired_at===null,403,'PRIVATE_STATE_FORBIDDEN');
  const active=service.store.get(`SELECT r.id FROM runs r
    JOIN workers w ON w.slot=r.slot JOIN sessions s ON s.id=r.session_id
    WHERE r.agent_id=? AND r.slot=? AND r.session_id=? AND r.state='ACTIVE'
      AND r.worker_epoch=w.epoch AND r.session_epoch=s.epoch AND r.lease_until>?
      AND s.lifecycle='RUNNING'`,agentId,slot,agent.session_id,service.now());
  ensure(agent.enabled&&active,403,'ACTIVE_AGENT_READ_REQUIRED');return slot;
}
