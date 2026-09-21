# Independent input, state and memory loop — SQLite V4

## Scope

This change connects #5's private working state to an ordered per-Agent observation loop (#6) and independent durable memory processing (#8). It adds a replaceable baseline for automatic recall (#10, partial) and state-version fencing of publication candidates (#12, partial). It does not establish real-LLM conversation quality, complete semantic memory reconciliation, autonomous agenda execution, or final acceptance of #4.

## Data flow

A committed message, message edit/deletion, or source insertion records a durable `agent_input_log` notification in the same SQLite transaction. It contains only the entity ID, event version, owner session and time. Public SSE status updates, browser views and diagnostic requests are not conversational input and never create new model work.

Each session Agent has independent `observed_input` and `memory_input` cursors. A claimed run selects an exact, bounded prefix after the corresponding cursor. `Context.delivery` contains purpose, from/through/target input IDs, completeness and every notification's ID and source version. The log is globally numbered but scoped to the session; gaps occupied by another session are not missing input. `Context.observation` remains the exact, possibly sparse model-input manifest, including extra recent context or LOOKUP. Do not interpret an optional retrieved original as proof that an intervening notification range was processed.

Selection occurs before the private-state manifest is bound. No mandatory delivery, review or retrieved evidence is silently trimmed after binding. A first mandatory item which cannot fit produces `CONTEXT_LIMIT`, leaves both cursors unchanged and requires an operator configuration correction/retry. Limits remain character-based; a model-specific tokenizer, semantic selection benchmarks and full token reservation are still #10.

## Listening without publication

`observe` accepts only `ABSTAIN`, optionally in the existing stateful envelope with a private patch. It is used to catch up a backlog and while a public decision is deferred or in its posting cooldown. It does not create a candidate or terminate the deferral. The usual `decide` action chooses SPEAK/DEFER/ABSTAIN only after its supplied input prefix reaches the current target. A LOOKUP is still an intermediate, owner-authorized request, not a public utterance.

A/B/C or 5/8 configured participants follow the same code path. Each request carries only its owner's private state and memory. Core schedules execution, validates evidence, enforces budgets and serializes publication; it does not choose opinions, a moderator, equal speech counts or a fixed speaker order.

Candidate review has both revision-delta and mandatory-input obligations. `coverage.complete` cannot be true while the mandatory input prefix is incomplete. A ready candidate must match current public revision, wake generation and its owner's private-state version. State changes during other work send a ready candidate back to review; previously accumulated waiting priority is not reset.

## Durable memory work and fair share

Memory uses its own cursor, rather than the recent context window or `processed_revision`. The first job freezes a target, takes at most `contextMessages` notifications and only advances to the actual through-input after the result commits. It may return no notes. It may cite only the same-session, current, undeleted message versions supplied in that memory chunk. Each new note records its source versions and producing run in `memory_input_origins`.

The action result, private patch, exact input receipt and cursor advance share one transaction. Duplicate successful results acknowledge the existing receipt; conflicting replay, stale input, wrong owner or invalid memory evidence cannot advance either cursor. Failed or cancelled work leaves its segment pending. Reopening SQLite and Core/Worker generation recovery resumes the next unprocessed range, never an inferred recent-history boundary.

`memoryShareEvery` (default 3) allows at most that many eligible foreground runs before a due memory run receives a slot. A pending memory job also runs when no foreground work is available. `memoryEvery` remains the initial notification-count threshold; `memoryFlushMs` (default 60000) makes a small residual backlog due by age. A started backlog continues to drain through its frozen target and any new tail. This guarantees an execution opportunity only when the Agent/provider is available, input fits and the explicit session budget permits work. It is not a throughput or cost guarantee for an unbounded source rate.

Diagnostics expose both cursors, both pending counts and oldest pending timestamps. The legacy `memory_revision` is retained as a diagnostic field, not the authority for which input was read. Unprocessed memory is explicitly present in model Context.progress.

## Edits and source limitations

A message edit/deletion adds a new notification without moving previous input IDs. If it occurs before an older notification is read, that notification supplies the current original and marks `superseded`; it does not fabricate the overwritten historical text. Tombstones remain redacted. If a supplied version changes in flight, its result is rejected atomically and the run is retired before reuse. This is an input invalidation, not a Provider outage. A malformed model patch is different: it terminates its run and consumes the existing bounded retry policy, rather than repeating an already-metered call under the same run ID.

Sources remain immutable rows under the current source API. Their notification delivers an explicitly marked excerpt of at most 1600 characters. It is not proof that the entire source document was read, and MemorySchema's note evidence remains message-based. Full source retrieval, revised source versions and agent-specific source ACLs remain #20.

## Automatic recall baseline

`MemoryRetriever` separates recall from SessionService. The first implementation ranks owner-only retained notes by Japanese word overlap and evidence links from current questions/working state, with recency only as a tie-breaker. It can select an older note outside both the latest twelve notes and the recent two hundred messages, before a participation decision. Selected notes include original messages and a record of omitted-for-budget candidates. Missing, foreign, deleted or version-mismatched originals are excluded. Legacy notes are labelled `legacy-unversioned`, not promoted to verified facts.

This deterministic baseline is not an embedding model or a guarantee of semantic paraphrase matching. Semantic recall comparisons, time/entity constraints, precision/recall measurements and full token budgeting remain #10. Meaning, contradiction and transitive provenance remain #9.

## Migration and operations

Stop Core/Workers, take a coherent backup, upgrade the locked build and restart through normal recovery. V1/V2/V3 databases migrate additively to V4. Existing messages, private state, persona snapshots, notes and user budgets are preserved. The new notification log is bootstrapped from currently retained originals. Both new cursors begin at zero because earlier recent-window processing did not prove full coverage. Existing notes keep their prior uncertainty; lost historic versions are not reconstructed. Reprocessing an old backlog consumes the existing explicit budget and may pause for renewal; migration does not increase it.

Active older runs are cancelled and existing pending provider calls remain abandoned until their recorded deadlines. Ready candidates require re-review. A V3 binary cannot open V4; rollback requires the matching pre-upgrade backup, not editing user_version or dropping tables in production. Test-only downgrade construction removes every additive V4 and V3 object to recreate a populated V2 fixture.

## Verification map

| Behavior | Evidence |
|---|---|
| Regression-first deferred observation and oldest memory segment | R2-LOOP-001 / R5-MEMORY-001, tests/agent-input-regression.test.ts |
| Exact 235-message ranges plus edit/tombstone for three independent cursor pairs | R2-LOOP-002 |
| Continuous-input memory share and nonempty/small backlog | R5-MEMORY-002 / 006 |
| Deferred private update, forbidden public observe output | R2-LOOP-003 / 004 |
| Unseen memory evidence, atomic source-change rejection, one replay receipt | R5-MEMORY-003 / 004; R2-LOOP-005 |
| SQLite reopen, unfinished work, pause and viewer independence | R5-MEMORY-005; R2-LOOP-006 |
| Explicit source excerpts and unfit mandatory input | R2-LOOP-007 / 008 |
| Old relevant recall with originals and owner isolation | R5-RECALL-001 |
| Candidate private-state binding | R4-STATE-001 and existing 200-delta review regression |
| 3/5/8 WorkerRuntime-to-Core HTTP paths and actual subsequent HttpModel request bodies | R2-LOOP-HTTP-001 |
| In-flight invalidation vs malformed state output, no reused unmetered run | R2-LOOP-HTTP-002 / 003 |
| Existing V1/V2, private-state, archive, authorization, browser and container regressions | Existing CI suites |

The HTTP tests run actual loopback Worker/Core requests; Provider responses are injected synthetic fixtures. Existing labs separately start 3/5/8 operating-system processes. Neither proves natural conversation, real Provider compatibility or long-term stability. Attach the final PR head and CI run before reporting acceptance. Diagnostic-only jobs may succeed even when verify fails; verify and container are authoritative.
