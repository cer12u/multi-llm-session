# Model-facing semantic contract

The model is not a transaction coordinator.

Live Providers receive a request-local semantic projection of the captured Agent context. Persistent UUIDs, session/agent ownership bindings, private-state version numbers, observation hashes and evidence versions are not model output responsibilities. The projection uses short handles:

- `self` and `a0`, `a1` for participants.
- `m0`, `m1` for supplied public messages.
- `s0`, `s1` for supplied source excerpts.
- `r0`, `r1` for supplied private memories.

The model chooses semantic actions, text, state content, evidence handles and memory relationships. For a state update it returns `state: {upsert, remove}`; it does not return `agentId`, `sessionId`, `expectedVersion`, `observationId` or evidence versions. Relative time is expressed as `afterMs`.

The Worker parses the model-facing schema, resolves every handle only against the exact captured Context, and constructs the internal `StatePatch`/memory/action contract. Unknown handles fail model-output validation and may use the existing single repair attempt. The Worker cannot resolve a handle to information that was not supplied. SessionService remains authoritative and independently revalidates owner, session, agent identity, private-state version, observation hash, exact message/source version, memory ownership and candidate publication fencing.

This separation is intentional:

1. Semantic inference quality should not depend on copying opaque UUIDs and optimistic-lock metadata.
2. Compact handles reduce prompt/output tokens and structured-output burden, especially for small and mid-sized models.
3. Security/concurrency invariants remain deterministic application logic.
4. A schema-valid model response is still not automatically accepted; Core semantic and transactional checks remain final.

Mock models retain the internal deterministic fixture contract because they test application state transitions rather than Provider instruction following. Real Provider paths always use the semantic contract before results reach Core.

The normal E2E includes an actual Core, three Worker processes, HTTP transport and SQLite. Its synthetic Provider asserts that no persistent UUID or transaction-binding field is present in the model request, returns only short handles, and verifies that the Worker synthesizes valid bound state patches which all three owners commit. It separately retains long-response lease/pause fencing. This establishes integration mechanics, not natural-language quality.

Real-model evaluation must still measure which model sizes reliably perform decide/draft/review/memory/LOOKUP and multi-Agent interaction. A Frontier model is not a required product dependency or an acceptance baseline.
