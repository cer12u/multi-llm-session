# Agent private working state — contract v1 / SQLite v3

## Scope and ownership (#5)

Character definition, private working state, long-term memories, pending public candidates and operational state are separate. Working state belongs to one **session Agent instance**, not to its character ID, worker slot, provider or display client. Reusing a character in another session does not share it.

`Context.self.privateState` contains `schemaVersion`, `agentId`, `sessionId`, `version`, `updatedAt` and working `entries`. An entry is a short understanding, interest, unresolved question or deferred intention. It is not a stored chain of thought or a shared truth. Evidence-free entries are personal interests/claims with no recorded grounding, not verified facts.

The current working set has at most 16 entries, at most 500 characters per entry, and at most 16,000 serialized characters. A patch changes at most eight entries and can explicitly remove entries. Capacity violations reject the transaction; there is no eviction of old state or long-term memory to make room. Accepted changes and explicit removals are retained in the private journal.

## Worker result

The existing `/v1/worker/runs/:id/result` endpoint accepts an envelope in addition to its legacy action-only results:

```json
{
  "action": {"decision":"ABSTAIN","reason":"Listen now; retain my question"},
  "statePatch": {
    "agentId":"<Context.self.id>",
    "sessionId":"<Context.self.privateState.sessionId>",
    "expectedVersion":0,
    "observationId":"<Context.observation.id>",
    "upsert":[{
      "id":"departure-question",
      "kind":"question",
      "text":"What time are we leaving?",
      "evidence":[{"kind":"message","id":"<supplied message ID>","version":1}],
      "resume":{"kind":"related_topic","agentId":null,"notBefore":null,"topic":"departure"}
    }],
    "remove":[]
  }
}
```

Bracketed values above are placeholders, not valid UUID/hash examples. Use the exact values in the claimed input. `statePatch:null` means no state change. An action-only result remains valid for previous clients and synthetic fixtures. The envelope also applies to draft/review/memory results. A LOOKUP is intermediate and never itself commits a patch; its final result uses the refreshed manifest.

The state and the action complete in **one SessionService SQLite transaction**. Invalid owner, stale run/worker/session epoch, stale state version, invalid observation ID, unseen/stale evidence, duplicate operations or invalid condition targets reject the entire result. A candidate created earlier inside that transaction is rolled back as well. The same completed result is acknowledged idempotently without applying its patch twice. A conflicting replay is rejected.

Existing-generation checks precede mutation. An identical receipt for an already completed run can still be acknowledged without another mutation; that is not permission for an old worker to update current state. No browser/admin state-patch endpoint is added.

## What was observed — and what was not

`Context.observation` hashes the complete selected Context (excluding the manifest itself), including the captured private-state version and actual evidence text. Its `messages` and `sources` list the exact IDs/versions in recent messages, review deltas, archive LOOKUP results and source excerpts. Message version means the source message's revision; a source's version is its immutable row's `fetchedAt` in the current source contract. Source versioning improvements remain #20.

`scope: selected-input-only` is deliberate. The initial `targetRevision` and sparse reference list **do not** assert that every earlier event has been observed. Existing `processed_revision` and memory-cursor behavior is unchanged and must not be interpreted as this manifest proving complete historical coverage. Sequential observation and memory backlog handling remain #6/#8. Short source excerpts remain excerpts, not proof that the full document was read.

State-aware prompts cannot silently discard the input that the manifest acknowledges. If it does not fit, HttpModel reports `CONTEXT_LIMIT` before HTTP transport. Full token accounting, selection and splitting remain #10; the legacy character budget is not a model-specific token guarantee. Output stays within `profile.maxOutputTokens`; stateful decisions are no longer additionally restricted to the old 512-token decision cap.

LOOKUP recalculates the observation binding after retrieving evidence. A state version change during that lookup cannot be silently rebased. References must occur in the bound selection and still match the live same-session original when the result is applied. This is structural provenance validation, not a guarantee that the natural-language claim is semantically supported.

## Persistence and migration

`agent_private_states` keeps the current version and working entries. `agent_state_updates` records run ID, version transition, selected-input manifest, accepted patch, before/after entries and timestamp. A unique run ID prevents duplicate journal writes. A no-change result records observation with equal before/after versions; a failed result has no successful state update.

V1→V2 remains the existing migration; V2→V3 adds only these two tables and their indexes. Existing Agent instances receive empty version-zero state. Legacy notes retain their original form and certainty. New instances lazily create their own empty row. Active pre-upgrade runs are fenced and in-flight calls remain abandoned until their existing deadlines; ready candidates require review. No stored user budget is expanded.

Stop Core/Workers before upgrading and keep a backup. Restart through the normal Core recovery path. A V2 binary cannot open a V3 database; rollback requires restoring the matching pre-upgrade backup rather than changing `user_version` on production data. The synthetic test that removes V3 tables is only a V2 fixture construction, not an operational rollback procedure.

Message edit/delete conservatively removes directly dependent working entries, increments their owner's version, and retains the change in the private journal. A request based on the previous version cannot complete. Indirect semantic derivations, memory conflict resolution and a general deletion/erasure policy are not provided by this change (#9/#24/#25).

## Privacy

Only the owning worker's claimed context carries its state. Other participants get public participant DTOs, not these entries. Public snapshot/events/transcript do not contain the state or patch. The private journal and stored run contexts can contain sensitive text and remain privileged local database data. Public deletion does not securely erase old private run records/journal entries/backups. General diagnostic/export interfaces remain #23/#25. Trace records contain only version/change/observation identifiers, never state text.

A saved `resume` condition is retained intention data, not an executable command or guaranteed wake job. Connecting those conditions to autonomous scheduling belongs to #7. No fixed turn order, obligatory reply, speaker equality, moderator or new paid call is added.

## Test matrix

| Acceptance | Test IDs / paths |
|---|---|
| Silent state returns only to its owner, with zero public agent messages | R2-STATE-001, `tests/private-state-regression.test.ts` |
| Duplicate/conflicting replay, owner/session/hash/version forgery and atomic action rollback | R2-STATE-002–005, `tests/private-state.test.ts` |
| Restart and same character in a separate session | R2-STATE-006 |
| Unseen/foreign/stale evidence, source edit/delete and earlier-run fencing | R2-STATE-007–009 |
| No-change versus failure, DEFER, explicit removal and target validation | R2-STATE-010–015 |
| Three actual WorkerRuntime↔Core HTTP paths; captured next HttpModel inputs differ by private state | R2-STATE-016, `tests/private-state-worker.test.ts` |
| LOOKUP binding, non-trimming context limit and structured-output compatibility | R2-STATE-017–019 |
| Populated V2 migration, capacity without eviction | R2-STATE-020–021 |
| Populated V1 migration and existing archive/recovery behavior | `tests/migration.test.ts`, existing regression suites |

These tests use synthetic model output. Provider transport in R2-STATE-016 is injected; WorkerRuntime↔Core uses loopback HTTP. They prove state transport and control invariants, not three real LLMs understanding a conversation. Final pass/fail must be attached to the specific PR head and CI run. #6–#13 and #27–#28 are not closed by this test matrix.
