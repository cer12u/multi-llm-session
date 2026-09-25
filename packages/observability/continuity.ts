import {Id,ensure} from '../contracts/index.js';
import {hash} from '../domain/index.js';
import {diagnosticProjection} from '../storage-sqlite/diagnostic-migration.js';
import type {SessionService} from '../session-service/index.js';
import {diagnosticSnapshot} from './index.js';

/** Current durable experience only, not ever-growing run contexts or an audit replay. */
const continuityTables=[
  'agent_private_states','memories','memory_metadata','memory_edges','memory_input_origins',
  'agent_input_cursors','agent_agenda','agent_agenda_bindings','agent_agenda_clock',
] as const;

export function continuityFingerprint(service:SessionService,id:string){
  Id.parse(id);
  return service.store.tx(()=>{
    service.session(id);
    const all=diagnosticProjection(service.store.db);
    const projection=continuityTables.map(table=>{
      const item=all.find(p=>p.table===table);ensure(item,500,'DIAGNOSTIC_CONTINUITY_SCHEMA_MISSING');return item;
    });
    // Reuse the bounded, owner-scoped projection reader. Every stored row and column
    // participates, including superseded memory, provenance and current cursor values.
    const state=diagnosticSnapshot(service.store,id,projection);
    return {kind:'private-continuity-fingerprint' as const,formatVersion:1 as const,sessionId:id,
      databaseSchema:Number(service.store.db.pragma('user_version',{simple:true})),capturedAt:service.now(),
      method:'sha256-canonical-table-rows' as const,
      tables:state.map((table,index)=>({table:table.table,rows:table.rows.length,sha256:hash({projection:projection[index],rows:table.rows})})),
      scope:'Current durable owner state, memory/provenance, cursors and agenda; not a historical replay or an operational backup.'};
  });
}
export type ContinuityFingerprint=ReturnType<typeof continuityFingerprint>;
