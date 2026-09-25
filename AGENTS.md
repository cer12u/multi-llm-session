# Implementation constraints

This project implements independent participant agents in dedicated Web-app sessions. Do not reintroduce Discord as the primary UI, a fixed speaker rotation, mandatory replies, a moderator LLM, or one model producing a script for all characters.

The source of truth for public speech is the SQLite commit in SessionService. Workers propose, but never directly publish. Preserve candidate revision/wake validation, command idempotency, worker/session generation fencing and private-memory isolation. Browser connections must never drive model invocation.

## Delivery and validation priority — user direction, 2026-09-25

Finish and integrate the remaining product functionality before expanding verification infrastructure. Add E2E-level acceptance scenarios, not new unit tests. Do not spend delivery time on unit-test coverage targets, exhaustive internal-function cases, or elaborate fixtures that merely mirror a changing implementation. This supersedes regression-first or per-component-test prescriptions for the remaining work.

New acceptance scenarios must exercise observable requirements through the actual application: browser/API/CLI, running Core and Workers, model transport, and persistent storage as applicable. A synthetic Provider may replace external inference for bounded credential-free checks, but do not replace the internal application path with scripted service calls or direct database writes and label it E2E. Real-model compatibility and conversation quality still require their separately authorized evaluation.

Keep existing tests and checks; do not create a separate project to delete, rename, reorganize or rewrite the unit suite. Do not disguise unit tests as integration tests to evade this priority. Group related implementation changes and use the relevant E2E scenarios to verify the integrated result. Report completed user-visible behavior and remaining failures, not test-count growth as product progress.

Node.js 24.20.0 and package-lock.json are the reproducible baseline. The existing checks remain available: `npm ci`, `npm run check`, `npm run lab`, and `npm run test:e2e` (after `npx playwright install --with-deps chromium`). Running existing checks does not require writing additional unit tests. Normal CI requires no model credentials and must remain read-only toward GitHub.

Use synthetic personas/data in public tests. Do not log credentials, full model prompts, private memory, or live transcripts into public CI. No paid model evaluation, deployments, main merges or changes to repository security settings without explicit authorization. Live model tests require the opt-in environment and hard runtime budgets.

Keep model policy in worker/model packages and atomic state transitions in SessionService. Preserve existing clock/randomness injection. Pin dependency and action versions; do not weaken acceptance assertions or mark a failing test skipped just to get green CI. Document known limitations honestly in docs/STATUS.md.
