# Versioned sources and independent participation (#20)

## Operator workflow

Open **セッション設定 → 資料を共有** in the actual Web app. The source manager supports original text, provenance URL, explicit publication date, broadcast or named Agent-instance audience, delivery enable/disable, and immutable version inspection. A historical version is read-only; reload the latest version before editing. The form uses the same operator-authorized routes as the CLI. Merely opening, polling or saving the form does not call a model. The independent Core scheduler processes material for running sessions.

Source material is not a public utterance. Each permitted Agent can discuss, defer, retain an interest, or ignore it. A reference or embedded imperative is untrusted data, not an instruction to change configuration, invoke an administrative action or obtain another participant's private state. Models are informed of these limits; ownership, run generation, actual observation and schema checks enforce the API boundary independently of model compliance.

`audience:null` explicitly broadcasts to all current/future participants of that session. A nonempty UUID array targets those **instances**, not names, characters, Worker slots or replacement participants. The operator can audit all originals; shared viewers cannot use source administration routes. An owner may independently choose to disclose material through its own public speech. This is not a promise that a real LLM will never quote its authorized private input.

## Originals, time and evidence

The source ID is stable. Material or audience/enable changes create a new immutable `version`; multiple changes within one clock millisecond are distinct. Identical normalized content and policy leave the version and observation log unchanged. `publishedAt` is the supplied publication time (unknown stays null), while `fetchedAt` is the time that original revision was acquired or applied. A newer acquisition date is not evidence of a newer event. Poll status records the latest successful check even when unchanged material does not create another revision.

Each model request contains a bounded source excerpt. Offsets and totalChars count UTF-16 code units, with surrogate pairs kept intact. A first excerpt is at most 1,600 units. `LOOKUP` with `kind:"source"`, the source UUID and the returned nextCursor obtains another authorized segment. Cursors bind the source ID/version and owner. Old versions, wrong owners and cross-session references are rejected; no original is silently substituted under a stale cursor.

The existing maximum of two LOOKUP rounds, three requests per round and total request/output budget remains. Large documents may require later runs; receipt of a source notification or excerpt does not mean the full document was read. Per-run manifests identify the actual source version, and the captured input records the supplied offsets/text. Source-grounded interests/understandings use the existing private working-state journal. The long-term memory-note contract remains grounded in public messages; this change does not pretend to automatically create unlimited source-derived memories.

Authorized chronological delivery checks both the notification version's audience and the current source audience. Other owners' private notifications are excluded, not claimed as observations. Their arrivals do not wake unrelated Agents, invalidate otherwise eligible public candidates or clear unrelated private participation assessments. Observation and memory cursors remain monotonic when access is revoked.

## Updates and withdrawal

Changes invalidate affected runs, source-dependent working state and agenda bindings; affected candidates require review, or are dropped when access is revoked. Cached old LOOKUP responses are removed and an expired run cannot reuse a previously accepted retrieval key. Original versions and private audit records remain, while only current authorized input can be reused for decisions. Previously public source events or public speech, old private contexts and backups are not forensic-erased by changing access.

Acquiring new text for a feed item **does not re-enable an individually disabled original or widen its individually restricted audience**. Changing the polling interval alone also preserves per-item overrides. An explicit change of the subscription's audience retargets its already stored originals immediately; operators must consider that a deliberate disclosure operation. Disabling the subscription stops acquisition but retains existing material and its individual delivery setting. Disable a source itself to revoke its delivery. Retired instance IDs remain attached to acquired items and are never mapped onto their replacement Worker occupant.

## Configured feeds and bounded jobs

ManualSource and ConfiguredFeedSource implement a common acquisition interface. Acquiring material does not itself grant an audience or publish speech. Feeds are selected by IDs from the deployment's configured list; the browser cannot enter an arbitrary fetch endpoint. The exact configured URL is the allowlist: HTTPS, or a configured loopback HTTP endpoint, with no embedded credentials/query/fragment. Redirects are rejected instead of followed, including changed final URLs from an injected transport. Link metadata is not fetched by this feature. This is not a DNS/IP firewall for an operator-chosen endpoint; deployment egress policy remains separate.

RSS/Atom XML is validated, external entity/DOCTYPE declarations rejected, and bodies streamed with a 1 MiB ceiling and 15-second deadline. Title/body limits are explicit errors rather than silent text truncation. At most twenty feed items are processed per acquisition; there is no claim of exhaustive pagination through arbitrarily large feeds. Date absence/parse failure produces unknown publication time, not the retrieval date.

Subscriptions, versions, last success/error, due time, retry count and jobs are persisted in SQLite. Three acquisitions can proceed concurrently. Jobs use a 30-second lease and version/token validation, claimed immediately before network I/O. Concurrent pollers cannot claim the same active job. A restart waits for an outstanding lease, then fences its expired result. Duplicate successful completion does not duplicate material. Changed subscription versions, expiry or an ended session reject delayed results. Pausing blocks new acquisition; an already started acquisition may finish and save material without resuming the session or invoking inference. Failures have separate bounded error codes and backoff (initial 60 seconds, capped at one hour), not Provider/model errors or natural quiet.

The UI shows configuration availability, enabled state, acquisition-in-progress, next attempt, last successful acquisition and safe error code. Explicit retry schedules a new opportunity; it does not resume a paused conversation. Invalid configured endpoints are shown unusable and skipped without blocking independent valid configurations. No credentials, full transport exception or HTTP error body is placed in ordinary logs.

## API and CLI

Source management is operator-only, including reads of private originals. Existing Host, Origin, login, bearer, cookie/CSRF and Idempotency-Key rules apply. Ended sessions remain read-only.

| Route | Meaning |
|---|---|
| GET `/v1/source-configurations` | Configured allowlisted feed IDs and availability. |
| GET/POST `/v1/sessions/:id/sources` | Metadata listing / idempotent original addition. |
| GET/POST `/v1/sessions/:id/sources/:source` | Current original / expectedVersion update. |
| GET `/v1/sessions/:id/sources/:source/versions[/:version]` | Original history / exact historical version for administrator audit. |
| GET/POST `/v1/sessions/:id/feeds` | Subscription/job status / expectedVersion update. |
| POST `/v1/sessions/:id/feeds/:feed/retry` | Explicit due-time retry with no lifecycle or budget renewal. |
| POST `/v1/worker/runs/:run/lookup` | Existing authenticated active-run retrieval, extended with owner-scoped source segments. |

After building, configure CORE_URL and ADMIN_TOKEN securely. Commands use the same routes:

```sh
npm run cli -- sources SESSION
npm run cli -- source SESSION source.json
npm run cli -- source-get SESSION SOURCE_UUID
npm run cli -- source-versions SESSION SOURCE_UUID
npm run cli -- source-update SESSION SOURCE_UUID update.json
npm run cli -- source-configurations
npm run cli -- feeds SESSION
npm run cli -- feed-save SESSION feed.json
npm run cli -- feed-retry SESSION FEED_UUID
```

An update file is the source definition plus expectedVersion. A feed file supplies configId, expectedVersion, optional intervalMs, audience and enabled. Schema export includes sourceUpdate and feedSubscription alongside runtime output contracts. Schema validation is not a replacement for owner, current-version and generation checks.

## V8 migration and recovery

V7 originals are retained with their previous fetched_at copied to their initial version so already persisted evidence remains valid. Future revision numbers increment independently of time. Migration adds source_versions, source_feeds, source_feed_versions and source_feed_jobs and version-aware input triggers atomically. Old active runs are fenced and old reserved calls remain accounted for. The first new subscription adopts its legacy configured-feed namespace without changing source IDs or duplicating notification history. Runtime never uses the test-only downgrade fixture.

Use the online storage backup and separate-path restore commands. Original versions, audiences, private state, receipt/cursor history and outstanding feed jobs are included. Rollback requires a compatible old binary and verified pre-update backup, not forced user_version changes or copying only a live SQLite main file.

## Evidence and limits

R6-SOURCE-000–005 cover real API admission, per-owner delivery, unrelated candidate progress, segmented originals/Unicode, publication dates, revision/revocation, stale cache/cursor rejection, atomic oversized retrieval and replacement-owner isolation. R6-FEED-000–002 reproduce acquisition policy regressions. R6-FEED-010–013 cover real HTTP errors/redirects/oversize/invalid XML/entities/timeout, simultaneous pollers, duplicate acquisition, subscription fencing, pause/end and audience withdrawal. R10-SOURCE-001–004 cover populated V7 migration, failure rollback, legacy feed identity adoption and exact V8 backup/restore with expired-job fencing. R6-SOURCE-020–022 cover three actual Core/Worker HTTP paths, independent discuss/defer/ignore choices, request policy, administration ACLs and CLI. R6-SOURCE-UI-001/002 exercise actual desktop/mobile forms, original revisions, targeted delivery, viewer/logout restrictions and retry/failure status.

All model responses and data in these tests are synthetic. They establish execution, ownership and persistence paths, not real-language comprehension, safe discretionary disclosure by arbitrary models, human-rated conversation quality or long-duration operation. #13/#27/#28/#29 and parent #4 remain separate. The final tested head and authoritative CI/merge results are recorded in PR #45; merely listing these tests is not a claim that the current CI has passed.
