# Candidate review continuity and eligibility (#12)

## Carrying interpretation across review chunks

The persisted candidate is the owner's current working draft. A review receives its complete text/intent and the actual bounded `fromRevision`, `throughRevision`, `targetRevision`, `complete` coverage, together with the independent chronological input-delivery window. Those boundaries remain authoritative; raising a LIMIT or listing a source ID is not a substitute for processing the missing range.

When `coverage.complete` is false, bare `KEEP` is rejected with `REVIEW_RECONSTRUCTION_REQUIRED`. The owner must return `REWRITE` containing the entire working draft and intent, or choose `DEFER`/`DROP`. Rewriting carries important corrections and the owner's interpretation of already processed chunks into the next request. It need not invent new facts, use different wording or satisfy a novelty score. Only the owner interprets the content; this is not a moderator or shared summary.

A successful REWRITE persists text, intent and version atomically with the result and existing state/input receipts. The next review receives that reconstructed candidate, not the initial draft. A final complete review can KEEP. A DEFER does not advance candidate review coverage and will reread that candidate range later; DROP explicitly abandons the candidate. A rejected bare KEEP cannot acknowledge input or publish a candidate. Model outputs that continue violating the contract fail within existing retry/call/operational budgets rather than looping without limit.

The original interest timestamp is never reset by draft generation, review, deferral, restart or content reconstruction. A new independently selected intention has a new timestamp. Under heavy finite updates, an owner can retain the same candidate and catch up instead of repeatedly returning to the end of the queue. An irrecoverably inappropriate or over-budget intention is dropped/reconsidered or stopped explicitly, not published without checking missing evidence.

## Identity, state and original evidence

Bound model contexts include `self.profileHash`, computed from the full frozen model-profile definition. It contains no credential value. Runtime checks compare the owner's full character definition, frozen model hash and enabled participant identity/version set. Worker online status and timestamps are not identity changes. Updating the global catalog does not change a frozen session profile and therefore does not spuriously invalidate it.

An active result whose identity no longer matches is rejected inside the same atomic transaction. Reclaiming such work cancels/replaces the old run instead of charging it as a Provider error or acknowledging its input. Publication checks the last completed draft/review context as well as the existing private-state version binding. Legacy contexts without a profile hash must be reviewed again, not grandfathered into publication.

Existing original revision/wake checks, retrieved memory/source-version invalidation, actual input receipts, candidate version, worker/session epochs, leases, current references and idempotent SQLite publication remain enabled. This change adds no asynchronous network work to a database transaction. Normal lifecycle/membership operations still fence generations; fault-injection tests also check that bypassing those operations cannot make a stale model/persona/participant candidate eligible.

## Conditional liveness, not equal turn counts

Selection remains based on eligibility, finite directed grace and waiting age. It is not a fixed rotation, mandatory equal number of turns or comparison of model self-reported scores. Consecutive contributions are not categorically banned. A five-times-slower model retains its original interested time while the faster participant may make new proposals.

A valid opportunity requires that relevant arrivals eventually slow enough for the owner to catch up, inference succeeds before leases/budgets expire, the intention remains valid, and the final revision/wake is still current. No finite queue rule can safely guarantee publication under continuously invalidating unbounded updates or a non-responsive Provider. In those cases the existing explicit retry/context/call/time limits stop work or the owner defers/drops; missing review is never declared complete just to guarantee a turn.

## Persistence and operational compatibility

The carry is stored in existing V6 candidate and run records; no new summary table, database daemon or migration is introduced. Core reopen preserves candidate text/intent/version, reviewed range and original interest time, while recovery fences old worker/run generations. Original messages and private journals are retained independently of the size of any model request. Rollback still requires a compatible binary and verified pre-update backup because older model behavior does not implement this review contract.

## Evidence

`R4-REVIEW-000` first reproduces the bare-KEEP defect. `R4-REVIEW-001` places a material correction in the first chunk and asserts that its corrected value remains in the actual candidate input when the original correction is absent from later deltas. It also checks age preservation and non-publication until coverage is complete.

`R4-REVIEW-002/003` exercise changed persona/model/membership, atomic rejection and fresh-run recovery. `R4-REVIEW-004` uses the injected clock with 100ms versus 500ms draft completion, three simultaneous candidates and repeated human interruptions. It records actual candidate wait, re-review count, dropped candidates and per-owner posts in `artifacts/review-fairness.json`; the explicit fixture timings are not a real Provider speed benchmark. Distinct eligible timestamps remove an accidental UUID-order-dependent test path so repeated interruptions are always exercised.

`R4-REVIEW-005` closes/reopens the actual SQLite Core after partial reconstruction and verifies continued coverage/text/age and one publication. `R4-REVIEW-006` uses a real authenticated Core HTTP Worker path, captures consecutive model requests and accepts a human message while the model promise is still pending. It checks there is no active transaction and the write completes before inference is released. `R4-REVIEW-007` covers empty delta with incomplete chronological delivery in the synthetic mock adapter.

The existing 200-intervening-message test keeps all source-ID, range and publication assertions. Only its synthetic action for an incomplete chunk changes from bare KEEP to a reconstructed draft. Existing edit-between-chunks, worker replacement, source invalidation, memory state changes, crash/idempotence and end/budget regressions remain active.

These are structural and scripted semantic fixtures. They prove that the selected correction is carried through the real code path, not that a real LLM correctly notices or preserves every correction. Mixed-model semantic validity and natural fairness are still measured separately in #28, with long-duration workload behavior in #29. No paid model calls, external deployment, permission changes or private live transcripts are involved. Final-head CI and merge evidence are recorded in PR #42.
