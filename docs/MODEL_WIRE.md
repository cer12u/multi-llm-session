# Model semantic wire

The LLM-facing contract is intentionally smaller than the internal transaction
contract.

For non-mock profiles using `jsonMode: "schema"`, the Worker sends semantic
context with short, request-local references:

- `pN`: participant
- `mN`: public message
- `sN`: source
- `memN`: recalled private memory

The model chooses participation, proposed text, memory meaning and private
working-state changes. It does **not** reproduce authoritative transaction
bindings such as agent/session UUIDs, state versions, observation hashes,
evidence versions, input cursors or database identifiers.

After structured output validation, the Worker resolves the short references
against the exact claimed Context and constructs the existing internal
`StatePatch`/memory action. SessionService then performs the same authoritative
transaction checks as before: owner and session, worker/session generation,
captured state version, observation hash, evidence version, memory ownership,
question routing, participation coverage and atomic SQLite commit. A forged or
stale model result therefore cannot bypass a Core check merely because the
binding work moved out of the model prompt.

The JSON Schema is supplied through the provider's structured-output mechanism.
It is not duplicated as text in the system prompt. This avoids charging model
attention/prefill for a second copy of the same protocol description.

The short references are local to one model request and are rebuilt after a
LOOKUP. They are not durable IDs. Persisted state continues to contain the real
IDs and versions produced by trusted application code.

`jsonMode: "none"` and `jsonMode: "json"` remain legacy compatibility modes
for providers that do not support strict structured output. They retain their
existing request/output contract; they are not evidence that the compact
semantic wire is in use. New live evaluation intended to measure smaller-model
viability should use schema mode.

The application E2E in `deploy/long-request-e2e.mjs` exercises the semantic
wire through the real Core, three Worker processes, HTTP transport and SQLite.
It checks that transaction-binding field names are absent from the model
context/schema, that delayed model output can still commit three independent
owners, and that pause fencing rejects an obsolete result.

This boundary reduces protocol burden; it does not prove natural conversation
quality. Real-model evaluation must still measure instruction following,
state/memory use and multi-agent interaction separately.
