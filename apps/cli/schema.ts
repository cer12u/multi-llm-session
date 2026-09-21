import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import {CharacterSchema,ModelProfileSchema,SettingsSchema,SessionCreateSchema,MessageInputSchema,SourceSchema,OutputSchemas,WireOutputSchemas,LookupSchema,PrivateStateSchema,StatePatchSchema,PrivateStateEntrySchema,InputWindowSchema,AgendaContextSchema,AgendaSignalSchema} from '../../packages/contracts/index.js';
const root=process.argv[2]??'artifacts/contracts';await mkdir(root,{recursive:true});
const schemas={agenda:AgendaContextSchema,agendaSignal:AgendaSignalSchema,inputWindow:InputWindowSchema,wireObserve:WireOutputSchemas.observe,privateState:PrivateStateSchema,statePatch:StatePatchSchema,privateStateEntry:PrivateStateEntrySchema,character:CharacterSchema,modelProfile:ModelProfileSchema,settings:SettingsSchema,sessionCreate:SessionCreateSchema,messageInput:MessageInputSchema,sourceInput:SourceSchema,...OutputSchemas,lookup:LookupSchema,wireDecide:WireOutputSchemas.decide,wireReview:WireOutputSchemas.review};
for(const [name,schema]of Object.entries(schemas))await writeFile(join(root,name+'.schema.json'),JSON.stringify(z.toJSONSchema(schema),null,2));
console.log(`Exported ${Object.keys(schemas).length} contract schemas. Runtime semantic checks still apply.`);
