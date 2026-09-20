# Implementation constraints

This project implements independent participant agents in dedicated Web-app sessions. Do not reintroduce Discord as the primary UI, a fixed speaker rotation, mandatory replies, a moderator LLM, or one model producing a script for all characters.

The source of truth for public speech is the SQLite commit in SessionService. Workers propose, but never directly publish. Preserve candidate revision/wake validation, command idempotency, worker/session generation fencing and private-memory isolation. Browser connections must never drive model invocation.

Node.js 24.20.0 and package-lock.json are the reproducible baseline. Run `npm ci`, `npm run check`, `npm run lab`, and `npm run test:e2e` (after `npx playwright install --with-deps chromium`). Normal CI requires no model credentials and must remain read-only toward GitHub.

Use synthetic personas/data in public tests. Do not log credentials, full model prompts, private memory, or live transcripts into public CI. No paid model evaluation, deployments, main merges or changes to repository security settings without explicit authorization. Live model tests require the opt-in environment and hard runtime budgets.

Keep model policy in worker/model packages and atomic state transitions in SessionService. Clock/randomness must be injectable in domain tests. Pin dependency and action versions; do not weaken tests or mark a failing test skipped just to get green CI. Document known limitations honestly in docs/STATUS.md.
