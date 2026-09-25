# Causal diagnostics and recorded-state replay (#23)

## What is recorded and what can be concluded

The operator's **セッション設定 → 診断 → 判断と根拠の追跡** panel lists actual runs. Selecting a run shows the chronological input interval, exact observation manifest, recalled memory IDs and budget omissions, captured context versions (including LOOKUP additions), private-state changes, memory changes, call stages and known/unknown usage, reason codes, candidate changes and public messages committed from those candidates. Public original links and versioned private-source links are separate.

These are recorded inputs, explicit decisions and state transitions, not hidden model chain-of-thought. A reason code such as ABSTAIN establishes the action taken, not an independent proof of why a language model chose it. The record permits inspection of the actual supplied state/evidence; it cannot reconstruct unrecorded internal reasoning. Current edited originals are never substituted for the older text in the captured request. Multiple contexts are linked to call context_hash values, and source offsets/version remain in the recorded context.

## Separate artifacts and permissions

GET `/v1/sessions/:id/transcript` is available to the authenticated shared viewer and operator. Its schema is a deliberate whitelist: public session identity/title/lifecycle/revision/episode and public message projections. No persona definition, private source original, draft, memory, run, prompt, credential reference or token consumption is added to it. The older operator-only `/export` endpoint now returns the same public-only projection; the path remains available, but callers needing internal diagnostics must select the new private route explicitly.

GET `/v1/sessions/:id/diagnostic-runs` and `/diagnostic-runs/:run` are operator-only and session-scoped. Listing uses stable row-position pagination, 25 entries by default and at most 50 per request. A detail response is limited to 2 MiB. Oversize is an explicit error, not a claim that omitted context was inspected.

GET `/v1/sessions/:id/diagnostic-export` is an operator-only, `application/x-ndjson` artifact with a `PRIVATE-diagnostic-...ndjson` filename. The browser asks for confirmation before downloading private content. Authentication is rechecked while streaming, so an expired/revoked cookie cannot complete the file. Bytes already received cannot be recalled by logout; a cut-off file lacks the completion footer and is not accepted as a valid replay. Existing Host/Origin/authentication rules remain in place. No new Worker or viewer administration privileges are introduced.

Private artifacts contain full permitted persona/state/source/candidate/context records for the selected session and therefore must not be published. Actual login/Worker credentials, live run bearer tokens, command-receipt replay capabilities and global catalog/health tables are excluded. Credential reference names within model profiles are not secret values. The feature cannot prevent an operator from putting sensitive material into ordinary public speech; such speech is public by definition. Keep real transcripts and private exports out of public CI.

## V9 journal and consistency

The additive V8-to-V9 migration preserves original application rows. It creates a private projection definition and append-only-by-application journal. Existing rows become explicitly labelled BASELINE entries: they are the retained migration state, **not fabricated historical actions**. Afterward, SQLite triggers record committed inserts, changes and deletions for the selected session-owned tables. Every journal row participates in the same transaction as the original mutation; rollback leaves neither side committed. Duplicate idempotent results do not invent extra changes.

Insert/delete records carry the projected row. Update records contain primary keys and only changed columns, avoiding repeated full contexts/personas on scheduling-counter updates. Table ownership is resolved through existing session/Agent/message/run/source relations. The projection excludes volatile heartbeats and runtime capabilities. It covers conversation and candidate state, exact inputs/receipts, private-state and memory history, owner agenda, membership/episode changes, source versions/feed jobs and call accounting. It does not recreate the global Provider circuit/catalog, Worker authentication or operating-system state.

Export captures a consistent journal high-water mark, expected record count, and an independently read final database projection inside one short transaction. It then streams bounded batches outside a transaction. New input can commit while the stream is being read and is excluded beyond that captured high-water mark. No network/model wait occurs while a write lock is retained.

## Offline replay, not model regeneration or operational restore

The replay reader applies typed recorded row changes to in-memory maps. It does not execute SQL, shell commands, JavaScript from data, configuration changes or model calls. It verifies allowed tables and columns, exact session, increasing sequence, keys, insert uniqueness, before-state values, compatible update keys, baseline ordering, record count, final high-water mark, total rows and final state hash. The public transcript is reconstructed from replayed message rows and their recorded author snapshots.

An NDJSON completion footer contains a SHA-256 checksum of the preceding exact lines. Truncation, reordering or byte corruption is rejected. Missing journal changes cannot be accepted merely by recomputing the stream checksum because the final independent projection is also compared. This is an integrity check, **not a digital signature**: someone who controls an entire artifact and rewrites both its contents and expected hashes can forge one. Preserve a trusted external checksum or signed storage record when authenticity is required.

The result is a verified **recorded private projection**, not a runnable restored session database. It does not replay missing pre-migration history, reproduce stochastic LLM choices or promise the same future conversation. Use the storage backup/restore tool for operational database recovery, not this replay output.

## Manifest provenance and unknown values

The artifact records database/projection format, SQLite version, settings, lifecycle/stop reason, frozen Agent character and model definitions/versions/hashes, adapter mode, known usage sums and missing-usage counts. It includes the exporting build SHA when supplied as BUILD_SHA/GITHUB_SHA. Unknown usage is not converted to zero and request token estimates are not represented as billable measurements.

Historical Core/Worker build SHAs and random seeds were not persisted by older execution paths. Their manifest fields remain null with an explicit missing-provenance explanation. The exporting build SHA is not relabelled as the build that performed every recorded historical run. `DIAGNOSTIC_EVIDENCE_MODE=synthetic|live` is an operator declaration, not proof of a real LLM: an HTTP adapter can also target a synthetic server. `liveModelVerified` remains false until separate evaluated evidence exists. Private context versions retain each run's actual frozen identity and inputs independently of this provenance limitation.

## CLI and storage limits

After building, configure CORE_URL and ADMIN_TOKEN through the normal secure environment:

```sh
npm run cli -- transcript SESSION_UUID
npm run cli -- diagnostic-runs SESSION_UUID
npm run cli -- diagnostic-run SESSION_UUID RUN_UUID
npm run cli -- diagnostic-export SESSION_UUID /secure/PRIVATE.ndjson
npm run cli -- replay /secure/PRIVATE.ndjson /secure/PRIVATE-replayed.json
```

File export/replay creates new mode-0600 files and refuses an existing destination. Downloads are streamed to a private temporary file, verified, then published with a create-only link. Failures remove the temporary file. Ordinary stdout for those file commands contains only artifact kind/count and a private-content warning. Run-detail CLI output is itself administrator-only diagnostic data and must not be redirected to public logs. Offline replay needs no API credentials and does not make a network request.

The current format limits a diagnostic artifact to 128 MiB, an individual line to 2 MiB and the materialized projection to 200,000 rows. Capture has a conservative preflight byte budget; oversized exports fail explicitly. The journal is retained in SQLite and included in normal online backups. This change does not implement retention pruning or guarantee constant disk use; monitor growth, especially for frequently changing large contexts. Long-duration storage/RSS/latency measurements belong to #29. The source/diagnostic migration tests use isolated synthetic downgrade helpers; they are never operational rollback tools.

Backup validation for V9 requires the projection tables, session-order index, generated recording triggers and matching selected schema. Use a verified pre-update backup with its compatible binary for downgrade. Public message deletion and private-access withdrawal are not forensic erasure of old diagnostic records or backups.

## Acceptance evidence

R10-DIAG-REGRESSION first requests the actual separate routes. R10-DIAG-000–005 test public whitelisting, real state/memory/candidate/edit/pause/recovery transitions, exact reconstruction, original request evidence, rollback/idempotence, compact updates, stream high-water/no-held-transaction, corruption/truncation/omission rejection and session-scoped run pages. R10-DIAG-006–008 test populated V8 migration, truthful baseline, migration rollback, exact V9 online backup/restore and missing-trigger refusal. R10-DIAG-009–011 test actual HTTP authorization/Host/Origin/logout/expiry, safe private CLI files, offline replay and incomplete streamed downloads. R10-DIAG-UI-001 exercises the actual operator browser explorer, state/evidence links, separate downloads, reload and viewer/logout isolation.

The final head, authoritative CI checks and actual artifact inspection must be recorded in PR #46 before acceptance. A listed test is not a passing result. Synthetic replay/control evidence does not establish natural-language accuracy, real Provider compatibility, human-rated conversation quality or long-duration stability. #13/#25–#30 and parent #4 remain separate.
