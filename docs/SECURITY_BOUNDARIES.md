# Integrated security boundaries (#25)

This is a private single-operator lab with a shared read-only viewer, not a public multi-tenant service. A browser session, Agent instance, Worker slot and model credential are separate grants. Neither natural-language instructions nor schema-valid model output can turn one grant into another.

## Enforced paths

Operator writes retain authentication, Host/Origin checks and cookie CSRF. Public projections are explicitly separated from private source originals, persona definitions, unpublished candidates, state, memory and diagnostics. Diagnostic downloads are private opt-in files. Do not publish their contents; a transcript is public speech only. All paths are session-scoped. Public data does not become privileged because it contains source IDs or instructions.

A Worker slot can be reused across saved sessions, so slot equality alone is not authorization to read every prior Agent. Legacy Agent read routes require an enabled, non-retired Agent with an ACTIVE, unexpired run matching current Worker and session epochs in a RUNNING session. Normal inference uses run-token/epoch-bound LOOKUP. Retired instances do not lend their private memory to their replacements. A Worker credential remains a trusted process credential: this is not isolation from an adversary who has stolen that credential and can register a replacement Worker.

Model profiles accept dedicated model credential names, not ADMIN_TOKEN, VIEWER_TOKEN, WORKER_* or process/control/GitHub/Actions environment aliases. A name ending _FILE cannot be selected as the secret value itself. Values and files are bounded to less than 16,384 bytes; empty values, embedded control characters, malformed UTF-8, non-regular files and ambiguous direct-plus-file binding are rejected. Secret files are opened nonblocking and the opened descriptor is validated. Deployment-provisioned paths are trusted; projected-secret symlinks remain supported. No model output or browser request supplies an arbitrary secret-file path. This is not an OS sandbox or a guarantee against a malicious deployment administrator.

Sources instantiate exact configured URLs, send no model/administrator credentials, refuse redirects and substituted final URLs, reject DTD/entity declarations and enforce byte/input limits. Existing source-audience/version and withdrawal checks remain mandatory. Browser speech is rendered as text with CSP, not evaluated HTML. No new external renderer or script execution is introduced.

## Logout, retention and traces

The browser's authentication epoch fences in-flight responses. A private diagnostic response that arrives after logout cannot populate the next viewer's UI. Local drafts/outbox are cleared by explicit logout using the existing durable draft generation contract; no tokens are stored in that database. Bytes already downloaded cannot be recalled, and browser/OS backups or forensic erasure are not promised. Public deletion, private-source withdrawal and removal from current context do not erase historical private journals or backups.

Ordinary CI uses synthetic data without live model credentials and read-only GitHub permissions. Security summary artifacts contain route counts and results, not raw private recordings. Diagnostic exports are explicitly distinct from public CI artifacts. Real prompts, private live transcripts and database backups must not be placed in public test artifacts.

## Evidence and limits

R10-SEC-000–003 cover credential aliases/byte bounds, actual profile API rejection, projected symlinks and cross-session Worker-slot reads. R10-SEC-010–012 cover public-route canaries, the integrated operator-route matrix including source/membership/replay, logout, and schema-valid forged owner/session/evidence results with transactional rollback. R10-SEC-020–022 cover transport redirection, input limits/CSP, UTF-8 and secret byte limits. R10-SEC-UI-001 exercises the real Chromium app: script-looking public speech, durable draft logout and a deliberately delayed private response followed by viewer login/reload.

Existing source URL policies, source revocation, private-state/recall, generation/lease, browser draft and authentication suites remain enabled. These bounded regression and adversarial fixtures do not prove absence of every vulnerability, semantic prompt-injection immunity or public-hosting readiness. Final-head test and merge evidence belongs in PR #47 and Issue #25. No security settings, CI grants, paid API calls or external deployments are changed by this work.
