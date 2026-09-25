import {OperationalBudgetSchema,BudgetPolicyUpdateSchema} from '../../packages/contracts/budget.js';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {z} from 'zod';
import {CharacterSchema,ModelProfileSchema,SettingsSchema,SessionCreateSchema,MessageInputSchema,SourceSchema,OutputSchemas,WireOutputSchemas,LookupSchema,PrivateStateSchema,StatePatchSchema,PrivateStateEntrySchema,InputWindowSchema,AgendaContextSchema,AgendaSignalSchema} from '../../packages/contracts/index.js';
import {SourceUpdateSchema,FeedSubscriptionSchema} from '../../packages/contracts/source.js';
import {CharacterRefSchema} from '../../packages/characters/index.js';
import {PresentationEventSchema,PresentationMessageSchema} from '../../packages/presentation/index.js';
import {SessionMemberSchema,MembershipUpdateSchema,SessionCloneSchema} from '../../packages/contracts/session-membership.js';
const args=process.argv.slice(2),check=args.includes('--check'),root=args.find(a=>!a.startsWith('--'))??'artifacts/contracts';
if(args.some(a=>a.startsWith('--')&&a!=='--check'))throw new Error('Usage: schema [DIRECTORY] [--check]');
await mkdir(root,{recursive:true});
const schemas={operationalBudget:OperationalBudgetSchema,budgetPolicyUpdate:BudgetPolicyUpdateSchema,sourceUpdate:SourceUpdateSchema,feedSubscription:FeedSubscriptionSchema,sessionMember:SessionMemberSchema,membershipUpdate:MembershipUpdateSchema,sessionClone:SessionCloneSchema,characterRef:CharacterRefSchema,presentationEvent:PresentationEventSchema,presentationMessage:PresentationMessageSchema,agenda:AgendaContextSchema,agendaSignal:AgendaSignalSchema,inputWindow:InputWindowSchema,wireObserve:WireOutputSchemas.observe,privateState:PrivateStateSchema,statePatch:StatePatchSchema,privateStateEntry:PrivateStateEntrySchema,character:CharacterSchema,modelProfile:ModelProfileSchema,settings:SettingsSchema,sessionCreate:SessionCreateSchema,messageInput:MessageInputSchema,sourceInput:SourceSchema,...OutputSchemas,lookup:LookupSchema,wireDecide:WireOutputSchemas.decide,wireReview:WireOutputSchemas.review};
const digests:Record<string,string>={};
for(const [name,schema]of Object.entries(schemas)){
  const text=JSON.stringify(z.toJSONSchema(schema),null,2),file=name+'.schema.json';
  await writeFile(join(root,file),text);digests[file]=createHash('sha256').update(text).digest('hex');
}
if(check){
  const baseline=JSON.parse(await readFile('config/schema-baseline.json','utf8')) as {schemas:Record<string,string>};
  const changed=[...new Set([...Object.keys(baseline.schemas),...Object.keys(digests)])].filter(name=>baseline.schemas[name]!==digests[name]);
  await writeFile(join(root,'schema-diff.json'),JSON.stringify({changed,matched:changed.length===0},null,2));
  if(changed.length)throw new Error('CONTRACT_SCHEMA_DRIFT: '+changed.join(', '));
}
console.log(`Exported ${Object.keys(schemas).length} contract schemas. Runtime semantic checks still apply.`);
