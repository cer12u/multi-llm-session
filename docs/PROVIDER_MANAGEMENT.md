# Provider management and bounded recovery (#15 / #16)

## Ordinary operator path

Open **モデルを管理** in the sidebar. The form creates an immutable model-profile version and exposes version history, definition hash and actual quota/circuit scope. Supported API families are Ollama Native non-streaming `/chat` and OpenAI-compatible non-streaming Chat Completions. This does not implement every Provider's proprietary API. Saving a profile does not contact that Provider or start an Agent.

Set the API base URL, exact model ID, authentication-reference name, JSON mode, output cap, concurrency and circuit policy. Ollama deployments conventionally use a base path ending `/api`, and Chat Completions deployments a base such as `/v1`; enter the deployment's real base, not a completed chat endpoint. Existing URL validation rejects embedded username/password, query-string credentials and fragments. Plain HTTP requires explicit local permission and an allowed loopback hostname. Do not embed a key in the URL or model ID.

Capabilities are declarations by the operator: supported JSON modes, `max_tokens` / `max_completion_tokens` / native `num_predict`, whether to send temperature, and whether usage is expected. The chosen JSON mode and token parameter must match the declaration and API family. JSON mode `none` means JSON is requested in ordinary model text, not that unstructured output bypasses schema validation. Legacy profiles omit capabilities and retain their original immutable hash. New declarations do not prove live compatibility; that is #27.

New sessions select the latest stored profile. Existing session Agents retain the original profile snapshot, model, endpoint, credential reference, limits and capabilities. The diagnostic panel shows frozen versus latest versions and the frozen endpoint/hash. Creating a new profile version does not apply it to existing sessions. In-place changes to existing participants belong to the explicit session-mutation contract in #19 and are not silently added here.

## Keys and shared scope

Profile rows, browser responses and exports contain the credential **reference name**, not its value. Supply the actual key to the relevant Worker using that environment variable or its `_FILE` secret-file binding. Providing both is rejected as ambiguous. Core presence checks are labelled `credentialConfiguredOnCore`: they cannot attest to the environment of a separately deployed Worker. A missing key in a Worker is a pre-send configuration error, not a successful connection test.

By default scope is derived from API family, normalized base URL and credential-reference name. Two profiles using the same key should use the same reference name. Different key references isolate quota and failure state. The optional `limitGroup` deliberately shares both concurrency and circuit state even across different references. The system does not inspect secret values to discover that two different names happen to contain the same key. Conflicting concurrency/circuit policies in a shared scope are rejected, including conflicts with immutable profiles pinned by non-ended sessions.

## Diagnosis and manual recovery

Open **セッション設定 → 診断**. The operations panel distinguishes voluntary quiet, observing, remembering, participation decision, drafting/reviewing, candidate wait, deliberate deferral, waiting for a named participant, cooldown, Worker offline, authentication/configuration errors, 429 wait, circuit/probe state, retry exhaustion and budget/session stops. It reports the next known opportunity or explicitly says it awaits a condition. A scheduled opportunity is not a promise that the Agent will publish.

Reads, rendering, browser reconnection and CLI status queries never make a model request. Explicit buttons confirm the action before mutation. **Agentを再試行** invalidates its old active run and retains remote-call reservations. **固定版のProviderを再試行** targets the displayed profile ID/version, not a potentially different newest endpoint. The action allows one probe for the shared scope; it does not allow an unlimited burst. Other Agents sharing that scope may also become eligible, which is shown in the confirmation text.

These operations do not resume paused sessions, renew budgets or reactivate ended sessions. Retry remains inside the existing budget. New public messages and sources do not clear accumulated errors or move a retry deadline earlier. A failed Provider does not stop independent scopes. Old Worker/session/run generations cannot publish or apply state; late usage accounting is retained without changing a newer circuit generation.

An external request may continue after a local timeout, cancellation or broken connection. Its accounting slot remains `ABANDONED` until the recorded deadline, unless a definitive result completes it. Do not assume an HTTP client abort cancelled inference at the service. Authentication failures block until explicit recovery. Retry-After is bounded and persisted. Local absence of a key produces no Provider request and no invented usage. Model-format repair is limited to one attempt; truncation, missing output, refusal and oversized responses are distinct errors, not silently accepted partial answers.

## HTTP and CLI

All additional routes are operator-only under the existing Host/Origin/authentication rules. Cookie-authenticated writes require existing CSRF protection. No Worker/viewer gets a new administration privilege.

| Endpoint | Behavior |
|---|---|
| GET `/v1/provider-catalog` | Latest profiles, hashes, scope/circuit state, Core key-reference presence and aggregate usage availability. |
| GET `/v1/model-profiles/:profile/versions` | All immutable versions for an exact profile ID. |
| POST `/v1/model-profiles` | Existing validated immutable-profile save; never runs inference. |
| GET `/v1/sessions/:id/operations` | Frozen/latest profile, Agent reason, next opportunity, pending work and recovery metadata. |
| POST `/v1/model-profiles/:profile/versions/:version/retry` | Explicit exact-version shared-scope probe, with Idempotency-Key. |
| POST `/v1/sessions/:id/agents/:agentId/retry` | Existing Agent retry with generation/run invalidation. |

Build first, set `CORE_URL` and `ADMIN_TOKEN` through the deployment's secure environment, then:

```sh
npm run cli -- profiles
npm run cli -- profile-versions PROFILE_ID
npm run cli -- profile-save profile.json
npm run cli -- operations SESSION_UUID
npm run cli -- retry-agent SESSION_UUID AGENT_UUID
npm run cli -- retry-provider PROFILE_ID VERSION
npm run cli -- pause SESSION_UUID
npm run cli -- resume SESSION_UUID
```

CLI writes use `IDEMPOTENCY_KEY` when explicitly supplied, otherwise a new command UUID. Reusing a key with changed command data is an error. CLI operational output is not a place to put real private transcripts into public CI. `config/examples/provider-profiles.json` contains configuration references only; replace model IDs/endpoints deliberately, and provision keys separately. The deployment/secret-mount path is tracked separately in #22.

## Acceptance evidence

`tests/provider-management-regression.test.ts` starts with the truncation/usage and stale-recovery defects. `tests/provider-operations.test.ts` exercises real registered APIs, exact-version recovery, frozen profiles, role/Host/Origin/CSRF/logout, CLI loopback HTTP and distinct quiet/working/stopped reasons. `tests/provider-capabilities.test.ts` checks API parameters, JSON modes, usage uncertainty and failure classification.

`tests/provider-http-failures.test.ts` runs actual WorkerRuntime → Core → local HTTP Provider paths for Retry-After/429, timeout after dispatch, transport break, definitely unsent missing-key failure and bounded invalid-model-output repair. It checks independent B/C progress, retained abandoned calls, no cursor acknowledgment on failed output and no failure reset from new messages/sources. Shared-key and shared-group scope tests retain a single probe and reject conflicting frozen policies. Existing populated-DB circuit recovery and actual Core/Worker crash tests remain enabled.

`tests/e2e/providers.spec.ts` creates three profiles through real Chromium forms, creates a session from those selected profiles, captures each Worker's model/endpoint/key/persona/context at three real loopback servers, and recovers an injected auth failure through the actual exact-version UI. A new profile version does not redirect the running session. The mobile/viewer test uses the real 390px editor and logout/role boundary. These servers return synthetic fixtures; no paid service is contacted.

Final-head CI must pass TypeScript, unit/HTTP tests, production build, schema export, 3/5/8-process mock labs, Chromium and the container smoke. Passing control/transport/UI tests does not establish live service compatibility, natural conversation quality or long-duration operation; #27–#29 and parent #4 remain separate. Keep raw prompts, real keys and live transcripts out of public CI.
