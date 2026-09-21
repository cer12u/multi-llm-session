# Explicit multi-provider Compose deployment (#22)

The existing `deploy/compose.yaml` stays the default, credential-free **mock** cluster. This separate path generates a live-capable configuration. Rendering it never creates/starts a session, contacts a model or deploys a service. A user must explicitly start a session after reviewing its budgets.

## Configuration and launch

Use the locked Node.js 24.20.0 environment. From the repository root:

```sh
npm ci
npm run build
# Copy either config/examples/deployment-shared.json or deployment-mixed.json
# to a PRIVATE location. Replace the .example URLs, model IDs and key-file paths.
node dist/apps/cli/deployment.js /private/deployment.json /private/new-session-runtime --allow-live
docker compose -f /private/new-session-runtime/compose.json config --quiet
docker compose -f /private/new-session-runtime/compose.json up -d --build
```

`allowLive:true` in the input and the explicit CLI flag are required. The file-secret launcher also requires `ALLOW_LIVE_MODELS=1`. Unknown profiles, duplicate identities, conflicting concurrency/circuit policies, missing or unreadable credential files and invalid Provider URLs are errors, not mock fallbacks. An `.example` address is only a placeholder; configure a real endpoint yourself. Ollama Native uses an `/api` base, while OpenAI-compatible Chat Completions uses its `/v1` base. This does not claim support for unrelated vendor APIs.

A deployment specifies versioned `profiles`, optional versioned `characters`, 3–16 `workers` and `sessionDefaults`. The generated `app.json` is the Core configuration. Workers receive the exact profile/persona snapshot in each authenticated claimed run; they do not receive a full copy of other characters or a separate mutable model choice. The generated `session-create.json` selects the configured Worker/character/profile triples. A single profile can be selected by all three Workers, or each can use a different Provider/model.

Create a DRAFT session and inspect it before explicitly starting it:

```sh
export CORE_URL=http://127.0.0.1:3000
# Read your private file into the environment; do not paste its value into a command or Issue.
export ADMIN_TOKEN="$(cat /private/new-session-runtime/admin-token.secret)"
node dist/apps/cli/command.js create /private/new-session-runtime/session-create.json
# Use the returned session UUID after reviewing the configuration and budget.
node dist/apps/cli/command.js status SESSION_UUID
node dist/apps/cli/command.js start SESSION_UUID
unset ADMIN_TOKEN
```

The existing GUI supports the same session creation/start path. Profiles are frozen into session Agent instances. Updating a catalog/config file does not rewrite an existing session's profile/persona. Model keys are looked up from the Worker's mounted binding at execution time, not embedded in that snapshot.

## Credential and filesystem boundaries

Output is create-only and must be **outside the repository/build tree**. Its directory is mode 0700. It contains private configuration and generated administrative/Worker tokens; never upload it as a CI artifact or commit it. The input uses `credentialFiles` paths, not inline model credentials. Only named, used bindings are copied. The original key files are not changed.

Compose JSON contains secret references/paths, not values. Each Worker receives its own Worker token and the model credential for its selected profile. It has no administrative token, peer Worker tokens, database volume or character catalog. The Core receives the Worker authentication tokens and configured model bindings because the existing configuration loader validates their presence at startup. Core does not send these secrets to the browser, model prompts, diagnostic reports or model profile records.

Generated secret files are read-only 0444 **inside the private 0700 directory**. This is deliberate: local Docker Compose file-secret mounts preserve host file modes; a mode-0600 file owned by a different host UID may be unreadable to the image's non-root `node` user. Parent-directory access is the host boundary; the bind-mounted individual files are readable by the container user. Do not move these files into a world-accessible directory. Root/daemon/OS-profile access is outside this protection; no encrypted-secret-store guarantee is made.

The image is built only from the repository, without generated secrets in its context/layers. Only Core mounts `session-data:/data`. The services retain the non-root image user, read-only root filesystem, temporary `/tmp`, dropped capabilities and no-new-privileges setting. These are Linux/local Docker configurations, not a public multi-tenant service.

Different credential references normally have different concurrency scopes. Deliberately shared account quotas can use the same explicit `limitGroup` with identical concurrency/circuit policy. The generator does not infer account identity by comparing secret values. Choosing a profile in the GUI whose credential was not mounted on that Worker yields a configuration error; add the appropriate binding through a reviewed deployment configuration rather than assuming every Worker has every key.

## Networking, failure and recovery

Published ports always bind `127.0.0.1`, even with a custom `publicOrigin`. For another PC use an authenticated SSH tunnel or a TLS reverse proxy; align its public origin and Host with `publicOrigin`. The generator does not open the firewall or expose an unauthenticated LAN endpoint. Local HTTP model URLs remain limited to the loopback exception already supported by the application; remote endpoints require HTTPS.

A disconnected Provider remains an API/transport failure and follows the existing bounded retry/circuit controls. A missing credential or live opt-in stops initialization/execution rather than substituting a mock model. Credential presence is not proof of valid service authorization: real Provider preflight remains #27. The synthetic test helper is opt-in, loopback-only, time-bounded and never part of a generated production command.

```sh
docker compose -f /private/new-session-runtime/compose.json ps
docker compose -f /private/new-session-runtime/compose.json logs --tail=100 core
docker compose -f /private/new-session-runtime/compose.json stop
docker compose -f /private/new-session-runtime/compose.json up -d --no-build
```

Do not add `--volumes` to normal shutdown. The same Compose project name retains the named DB volume across container recreation. The generator sets `RESTART_POLICY=paused` for inspection before resumption. This preserves stored history, private state, memory/cursors, agendas, receipts and circuit state; configuration generation is not permission to resume a stopped or exhausted session.

For image updates, take a verified backup, stop the services, rebuild and recreate them using the same generated configuration/project/volume. For config or credential changes, render a new private output directory, keep the same project name to retain the volume, review the new session/profile versions and recreate **all** services together. A fresh rendering generates fresh administrative/Worker authentication tokens, so re-login is necessary; this is explicit key rotation, not session-data deletion. Retain credential bindings needed by frozen existing sessions. Roll back an incompatible schema only with the matching pre-upgrade backup, never by forcing `user_version` backward.

Use `docs/STORAGE_RECOVERY.md` for backup/inspection/restore. For example, while Core is online create a consistent SQLite backup inside its private data volume, then copy the completed backup to private host storage:

```sh
docker compose -f /private/new-session-runtime/compose.json exec -T core node dist/apps/cli/storage.js backup /data/conversation.sqlite /data/before-update.sqlite
docker compose -f /private/new-session-runtime/compose.json cp core:/data/before-update.sqlite /private/backups/before-update.sqlite
```

The backup name must be new. A backup on the same volume alone is not off-host protection. Switching to a restored database requires stopping Core/Workers and following the separate new-path restore procedure. Never copy only an open SQLite main file without its committed WAL.

## Acceptance

`R10-DEPLOY-001–003` test schema/opt-in, create-only output, no inline credentials, Worker ownership, Core-only DB, immutable profile versions and invalid/missing bindings. The separate read-only deployment workflow builds the non-root image and boots two generated clusters: shared model × three personas and three heterogeneous Provider/API profiles. Three independent Worker containers use actual loopback HTTP stubs that validate model, profile version, bearer authentication, persona and Agent identity. The smoke verifies retained private memories, originals and lifecycle after Core recreation, plus a persisted injected 429 circuit in the heterogeneous case.

CI uses only generated synthetic credentials/data and reports aggregate evidence in `artifacts/multiprovider-compose.json`. No real model inference, registry publishing, outside deployment or real conversation quality is claimed. Passing metadata must be recorded at the final PR head; neither a draft PR nor a successful diagnostic-display job is acceptance.
