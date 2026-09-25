# Requirement-based control verification (#26)

The acceptance target is independent participants with persistent private state, not a particular mock line, minimum utterance count or natural-language quality score. The production authority is SessionService's committed SQLite state. Tests below exercise that authority and the actual HTTP/browser/process boundaries; they do not establish live Provider compatibility or human-rated conversation quality.

| Requirement | Executable evidence |
|---|---|
| Owner-only knowledge, silence updates and later return | private-state.test.ts, private-state-worker.test.ts, agent-loop-http.test.ts, agenda.test.ts, conversation-flow-http.test.ts |
| Independent observation and over-200-message memory backlog | agent-inputs.test.ts, agent-input-regression.test.ts, memory-semantic-acceptance.test.ts |
| Old originals, paraphrase retrieval and budgets | memory-recall-acceptance.test.ts, memory-budget-acceptance.test.ts, memory-lookup-budget.test.ts, provider-memory-integration.test.ts |
| Wrong attribution, corrected/deleted evidence, private memory isolation | memory-attribution-boundaries.test.ts, memory-v6-recovery.test.ts, security-route-matrix.test.ts |
| Third participant hears and uses the exchange | conversation-understanding.test.ts, conversation-worker-http.test.ts |
| Simultaneous candidates, stale epochs and five-times-slower generation | session.test.ts, review-continuity.test.ts, review-lookup-identity.test.ts, review-recovery-http.test.ts |
| Natural restraint vs Provider failure and budgets | conversation-flow.test.ts, conversation-flow-http.test.ts, provider-http-failures.test.ts, provider-operations.test.ts |
| Timer/source opportunities without a viewer | agenda.test.ts, source-feed-http.test.ts, source-worker-api.test.ts, conversation-flow-http.test.ts |
| Three, five and eight distinct Worker processes | apps/cli/lab.ts, run by the unchanged normal verify job; separate multi-provider-compose synthetic deployment |
| Message/state commit crashes and recovery | storage-crash.test.ts, storage-worker-crash.test.ts, session-membership-recovery.test.ts, observability-recovery.test.ts |
| Session/persona replacement and source audience/versions | session-membership*.test.ts, source-versioning.test.ts, source-audience-regression.test.ts, source-recovery.test.ts |
| Public/private export and replay | observability.test.ts, observability-http-cli.test.ts, security-route-matrix.test.ts |
| Full pages/old replies/reconnect and durable outbox | archive-*.test.ts, draft-*.test.ts, tests/e2e/archive.spec.ts, tests/e2e/drafts.spec.ts |
| Actual management/recovery/private UI | tests/e2e/providers.spec.ts, tests/e2e/observability.spec.ts, tests/e2e/security-boundaries.spec.ts, existing character/member/source browser tests |
| Seeded state-machine sequences and negative oracle | R10-STATE-001/002 in agent-state-machine.test.ts and fixtures/agent-state-machine.ts |

## Seeded event model

Nine fixed cases combine 3/5/8 owners with seeds 19421, 78437 and 91283. Each applies 72 commands through the actual SessionService, not a pure candidate-array imitation. Commands include original input, edit/deletion, source audience, inference-result completion, finite deferral, Worker replacement, Core recovery, pause/resume and explicit budget renewal. Every owner starts with a distinct synthetic private-state canary. After each command, database invariants check run/candidate exclusivity, committed publication ownership, reply session, stopped-session fencing, window limits, foreign keys and peer/public private-state isolation. At completion, actual recorded journal replay is compared with an independently read current projection.

Negative outputs conform to the wire schema but carry a foreign owner. They must fail semantically without changing private state, then a valid result can complete the same still-valid run. The separate oracle test deliberately corrupts a reply's session relationship and a call limit: the checker itself must reject each. Fixed synthetic response text is not used as a proof of understanding.

Each case writes the seed, command list, real counts and pass/fail result to artifacts/state-machine. A state-machine failure retains its executed prefix and delta-debugs it to a single-deletion 1-minimal sequence for the same error. This is not guaranteed to be the globally shortest counterexample. No raw credentials, live conversations or private production data enter these artifacts. IDs are represented by generated slot/choice operations rather than depending on production identifiers. UUID tie breaking is not claimed deterministic; assertions concern invariant outcomes, not a fixed speaker order.

## Existing acceptance and scope

Normal CI remains secret-free and read-only toward GitHub. It retains locked dependency installation, typecheck, all unit/HTTP/storage tests, production build, schema export, 3/5/8-process labs, Chromium and container checks. No required assertion is disabled or a failing test skipped. These additions supplement the existing over-200-input, process-crash, multi-tab and delayed-Provider cases; they do not replace them with a simpler seed test.

Provider identity, timestamps, observed evidence, private state and source permissions must survive all combinations. Runtime code, bound contexts and actual database records are inspected; successful mocks alone are not acceptance. Delays in existing five-times-slower tests are controlled fixtures, not a benchmark of any real Provider. Live API formats and actual conversation reading remain #27/#28/#13. Budget extensions and long-duration measured workloads remain #29. The final cross-cutting report must name the verified head and authoritative CI rather than infer completion from test counts.
