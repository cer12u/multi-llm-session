import { AppError, type Context, type ModelProfile, type RunKind, type Settings, type EvidenceRef } from '../contracts/index.js';
import { ModelError, modelRequest, estimatedRequestTokens } from './index.js';

const unique=(refs:EvidenceRef[])=>[...new Map(refs.map(r=>[`${r.kind}:${r.id}:${r.version}`,r])).values()];
/** Preview has the same public references and hash length as the final private-state manifest. */
function preview(input:Context):Context {
  const context=structuredClone(input);
  context.observation={id:'0'.repeat(64),targetRevision:context.revision,trigger:context.trigger,
    scope:'selected-input-only',historyTruncated:context.historyTruncated,
    messages:unique([...context.messages,...context.delta,...(context.retrieved??[]).flatMap(r=>r.messages)]
      .map(m=>({kind:'message' as const,id:m.id,version:m.revision}))),
    sources:unique(context.sources.map(s=>({kind:'source' as const,id:s.id,version:s.version??s.fetchedAt})))};
  return context;
}
/** Selection headroom only; the final request still uses the original authorized limits.
 * Oversized lookups fail explicitly rather than deleting acknowledged observations.
 */
export function lookupSelectionSettings(profile:ModelProfile,settings:Settings):Settings {
  const tokens=Math.min(settings.contextTokens??65536,profile.contextWindowTokens??Infinity);
  return {...settings,
    contextChars:settings.contextChars-Math.min(4096,Math.floor(settings.contextChars/5)),
    contextTokens:tokens-Math.min(8192,Math.floor(tokens/8))};
}
/** Includes persona, state, all evidence, output schema (also response_format), framing, one worst-case repair and reserved output. */
export function boundedContext(input:Context,kind:RunKind,profile:ModelProfile,settings:Settings):Context {
  const context=preview(input),maxTokens=Math.min(settings.contextTokens??65536,profile.contextWindowTokens??Infinity);
  context.inputBudget={method:'utf8-upper-bound',tokenizer:'unknown',maxTokens,reservedOutputTokens:profile.maxOutputTokens,estimatedInputTokens:maxTokens};
  try {
    // A JSON-escaped control character consumes six bytes, the worst case for each of 2,000 UTF-16 repair units.
    const estimated=estimatedRequestTokens(modelRequest(profile,kind,context,{maxChars:settings.contextChars,repair:'\u0000'.repeat(2000)}));
    if(estimated+profile.maxOutputTokens>maxTokens)throw new AppError(422,'CONTEXT_LIMIT');
    context.inputBudget.estimatedInputTokens=estimated;
    return context;
  }catch(error){
    if(error instanceof ModelError&&error.code==='CONTEXT_LIMIT')throw new AppError(422,'CONTEXT_LIMIT');
    throw error;
  }
}
export function contextFits(input:Context,kind:RunKind,profile:ModelProfile,settings:Settings):boolean {
  try{boundedContext(input,kind,profile,settings);return true;}
  catch(error){if(error instanceof AppError&&error.code==='CONTEXT_LIMIT')return false;throw error;}
}
