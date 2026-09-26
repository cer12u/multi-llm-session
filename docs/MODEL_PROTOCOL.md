# Model protocol boundary

The model is an independent conversation participant. It is not a database client,
transaction coordinator, lease owner, or identifier authority.

## Request-local semantic handles

Live model requests expose short handles for entities supplied in that exact request:

- `self`, `p0`, `p1`, ...: the current participant and current peers.
- `m0`, `m1`, ...: supplied public messages.
- `s0`, `s1`, ...: supplied source excerpts.
- `k0`, `k1`, ...: supplied private memories belonging to this Agent.

The model never needs to copy an Agent UUID, session UUID, state version, message
revision, source version, profile hash, or observation hash. Historical speakers that
are no longer current participants can still appear as conversation data, but are not
turned into an addressable current `p*` handle.

For schema-capable Providers, the compact semantic JSON schema is sent through the
Provider's structured-output field. It is not duplicated into the system prompt. For
JSON-only Providers the same compact schema is included once in the prompt.

## Model output versus internal command

The model returns semantic intent only. Examples include:

- speak/defer/abstain, a draft, or a review decision;
- state entries to upsert/remove, with request-local evidence handles;
- memory notes/changes, with request-local message/memory handles;
- bounded lookup requests using text or a handle already supplied in the request.

The Worker validates this model-facing schema and translates the handles back to the
exact internal entities captured by the run. It then injects trusted binding metadata
from the captured context: Agent/session identity, expected private-state version,
observation hash, evidence versions and the current delivered-input boundary.

That translated result is still validated against the existing internal wire contract
before it reaches Core. SessionService remains the only writer. Core still rejects stale
Worker/session generations, stale private-state versions, wrong owners, stale or
unobserved evidence, stale memories and obsolete candidates. A smaller model is never
allowed to weaken these checks; it simply no longer has to reproduce them.

## Why this boundary exists

Requiring an LLM to emit transaction metadata does not test conversational reasoning.
It consumes input/output tokens, increases structured-output complexity and makes model
size compensate for protocol bookkeeping. The application should own bookkeeping;
the model should own semantic choices.

A successful synthetic Provider E2E proves translation, fencing and persistence, not
natural-language quality. Real-model acceptance still requires actual model runs and
human/semantic evaluation. Conversely, a real model failing the semantic schema is now
a model/prompt compatibility signal rather than a failure to copy internal UUIDs.
