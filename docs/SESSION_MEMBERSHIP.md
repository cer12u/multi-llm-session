# Session membership, continuity and exact versions (#19)

## Operator path

Open **セッション設定 → 診断 → 参加者と継続設定**. The ordinary form loads exact character/profile versions and the current session epoch. It distinguishes current, disabled, disconnected and erroring participants from retired historical owners. A connected Worker is not proof that its Agent is speaking or that a real Provider is healthy. Reading this form, opening episodes, reconnecting a browser and having zero viewers do not invoke a model.

Membership writes require an operator, the normal Host/Origin/CSRF boundary, an Idempotency-Key, and a session in **DRAFT or PAUSED**. The submitted `expectedEpoch` must match the stored session epoch. The editor keeps unsaved rows on a detected epoch change, disables applying stale rows and offers an explicit reload/discard confirmation. Reload does not apply anything. Save confirms that old runs and unpublished candidates will be invalidated. It never resumes the session or renews a budget.

A configuration has 3–16 current individual instances, using distinct configured Worker slots. Enabled count may be lower; the form and operational reasons report that fact rather than presenting every configured participant as active. Three, five and eight participants follow the same implementation. The initial simultaneous RUNNING-session cap stays one.

## Retained instance versus replacement

Each submitted participant includes `agentId` (existing UUID or null), `slot`, exact `{id, version}` character/profile references, and `enabled`.

For an existing instance, keep its UUID and slot. A different version of the **same character ID**, or an explicitly selected model-profile version, is applied to that instance. Its private working state, unresolved questions, memory, original evidence, observation/memory cursors and retained agenda stay with it. A profile change resets that instance's old profile-specific error state, not a shared Provider circuit or a session's exhausted budget. A persona-only change does not clear an outage. Publishing a new catalog version alone still changes no existing participant.

To change to a different character ID, use **別のAgentとして交代**. The submitted `agentId` becomes null. Save retires the old owner and allocates a fresh UUID for the new owner, even when the same Worker slot or character definition is reused. Removal from the submitted current roster also retires the old owner. Retired rows, original speech, private memory and journals are not relabelled, deleted or transferred. The new instance starts without private experience; it can observe retained public history through the normal bounded input path. Retired instances cannot be re-enabled through the older toggle/retry APIs.

Existing slots cannot be moved by editing their instance record. Retire and add an instance instead; arbitrary private-memory transfer between Worker slots is deliberately not implemented. The schema's partial uniqueness constraint allows one current instance per `(session, slot)` while keeping retired instances with their original slot metadata. The database enforces that retired instances cannot be enabled.

The entire reconciliation, epoch/revision change, membership journal, run/candidate fencing, response-cache revocation and command receipt are one synchronous SQLite transaction. All references/policies are checked before mutation. A failed or stale command leaves no partial retirement, new instance or receipt. An unchanged roster is a no-op. Replaying the same successful command returns its original result, not a second new instance; changed data under the same key is a conflict.

Late external calls remain accounted for after cancellation; cancelling a local run is not a guarantee of cancelling remote inference. Existing late usage may be recorded, but it cannot publish old speech, mutate the replacement owner or override a new Provider generation. Both direct private-memory paging and older cached LOOKUP responses are protected against reading retired-owner inputs through the reused slot. Retirement revokes only that owner's cached private LOOKUP responses; exact bound run contexts, memories, state journals and original evidence remain private audit records. A subsequent old LOOKUP must pass run validation and is rejected as stale.

## Immutable public authorship

Every Agent-authored message has an author snapshot written during its original insertion: author instance UUID, character ID, character version and displayed name. Future version application or retirement does not change these values in snapshots, history, search, event projections or exported transcripts. The original text/sequence/reply tree also remains intact. Old authored messages are backfilled from their already frozen V6 instance definitions during migration. There was no supported V6 in-place persona application whose lost older name could be reconstructed; hand-edited databases are not a source of provable earlier identity.

## Episodes and lifecycle

Episodes are non-exclusive chronological indexes, not delivery partitions. The existing gap setting determines when a new message starts another episode. Each episode records start time, last message time, first/last original sequence, closing time and end sequence. An empty created session has an empty sequence range (`firstSequence=1`, `lastSequence=0`). A later gap closes the previous episode at the next episode's first message time. Ending a session records its actual close time. Editing or deleting a message does not renumber its original sequence or create a new episode.

Migration derives old episode message bounds from the retained originals. For an already ended legacy session whose exact ending time was never saved, `origin` explicitly includes `end-time-unknown`; its last known message/start time is not represented as a newly measured end time. New episode records use `recorded`. Neither gap boundaries nor long pauses erase private state, unresolved questions, memory or public history. Core recovery and explicit budget renewal keep those owner records. Budget renewal starts a new authorized window; it does not erase lifetime call/post counters.

ENDED remains closed to new conversation, membership, settings and source writes. Reading, export and creating a separate definition-only session are allowed. Already dispatched call accounting remains a separate recovery concern, not permission to restart the ended session.

## Definition-only cloning

**定義だけを複製** requires a new title and the explicit `copy: "definitions-only"` scope. The UI confirms that no public transcript, private state, memory, unresolved question, agenda, cursor or run is copied. It copies the **saved current roster's exact frozen definition versions**, enabled flags and session settings, not unsaved form changes or the latest catalog versions. Every participant receives a new UUID. The new session is DRAFT with empty public history and zero consumption. The source, including an ENDED source, is unchanged. No cross-session character lifetime or shared experience is inferred. Unsupported copy scopes are rejected.

## API and CLI

| Endpoint | Scope |
|---|---|
| GET `/v1/sessions/:id/membership` | Operator-only current/retired metadata, counts, version choices and episode ranges. No private persona text or key values. |
| POST `/v1/sessions/:id/membership` | Explicit epoch-checked DRAFT/PAUSED reconciliation. |
| GET `/v1/sessions/:id/episodes` | Authenticated read-only episode metadata; no private diagnostics. |
| POST `/v1/sessions/:id/clone` | Operator-only definition-only new DRAFT session. |

Build and configure the existing `CORE_URL` and `ADMIN_TOKEN` securely, then use:

```sh
npm run cli -- members SESSION_UUID
npm run cli -- episodes SESSION_UUID
npm run cli -- members-apply SESSION_UUID membership.json
npm run cli -- clone SESSION_UUID clone.json
```

`membership.json` contains `expectedEpoch` and the full intended `participants` array. `clone.json` contains only `title` and `copy: "definitions-only"`. The CLI uses the same HTTP routes and idempotency rules as the browser, not direct SQLite writes. Secret values must never be placed in these files, issue comments or public CI.

## V7 upgrade, backup and rollback

Stop Core and Workers and verify a pre-update online backup before upgrading a real deployment. V7 rebuilds the Agent table using the create/copy/drop/rename procedure to replace the old unconditional slot uniqueness constraint, preserving every ID, rowid, existing column and child reference. Foreign-key enforcement is disabled only on the migration connection outside the transaction, the resulting references are checked before commit, and the prior enforcement setting is restored in `finally`, including on failure. No `writable_schema`, permanent foreign-key disabling, data discard or in-place operational backup replacement is used.

V7 adds membership journals, author snapshots and episode tables/triggers. Backup inspection requires those objects and complete authored-message snapshots. Online backup and separate-path restore include all current/retired owners, working state, memory metadata/edges/journals, cursor/agenda data, author snapshots and episode ranges. Roll back with the corresponding verified pre-upgrade backup and old binary, not by changing `user_version` or dropping objects in a real database. `tests/fixtures/session-v6.ts` is restricted to synthetic test construction and refuses fixtures with retired owners; it is not an operational tool.

## Acceptance mapping and limits

`R7-MEMBERS-000` first reproduces the absent real route. `001–004` test replacement ownership, exact version application for 3/5/8 instances, immutable published identity, atomic invalid inputs, idempotency, actual enabled/offline/error counts, long-pause episode bounds, budget-state retention, ENDED writes and explicit clone scope. `005–007` use populated V6/V7 databases, deliberate mid-migration failure, foreign-key restoration, exact online backup/reopen and malformed-backup refusal. Existing V1/V2/V4/V5 migration assertions remain enabled using genuine pre-V7 fixture structures.

`008–010` exercise authenticated real Core/Worker HTTP with pending model inference, CLI through real routes, role/Host/Origin/CSRF/logout boundaries and replay-cache retirement. `R7-MEMBERS-UI-001/002` use the real production Chromium app for version application, owner replacement, old author preservation, cloning, reload, 390px layout, stale-epoch unsaved edits and viewer denial. These are synthetic control/transport/persistence proofs, not real-model personality or long-duration quality measurements. Final-head authoritative CI and merge status are recorded in PR #44; an intermediate green head is not final acceptance.
