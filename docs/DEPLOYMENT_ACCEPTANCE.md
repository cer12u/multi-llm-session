# Deployment configuration constraints and test mapping

Read [MULTIPROVIDER_DEPLOYMENT.md](MULTIPROVIDER_DEPLOYMENT.md) for launch, shutdown, backup, updates and rollback. This supplement records the final validation boundaries introduced by PR #40.

## File and update constraints

Both generated output and every source credential file must resolve physically outside the repository/build context. An alias/symlink does not make an in-repository source or output acceptable. The output parent directory must already exist; the output directory itself must be new. Generation validates credential sources before creating its private output. Trusted operators must control these directories; protection against concurrent malicious filesystem replacement by a user with directory write access is not claimed.

A model credential source must be a regular file smaller than 16,384 bytes. Its trimmed value must be nonempty and contain neither embedded newlines nor NUL. Original files are never modified. The generated private directory is mode 0700; its mode-0444 secret files remain accessible to the image's non-root user through individual Docker file-secret mounts. Do not relocate them into a publicly accessible directory.

A freshly generated deployment pins its supplied catalog versions, but session creation still uses the existing latest-catalog selection contract. A populated database can contain later catalog versions from previous imports. Before creating/resuming a session, inspect the catalog and its frozen profile/character versions rather than assuming an older deployment file downgrades that database. Existing session snapshots are not overwritten.

Each generated Worker mounts only the credential for its selected deployment profile. For an existing frozen session, retain the same required binding on that Worker; changing it to a different credential reference does not automatically migrate old sessions or grant them the new key. Updating a persona/provider within an existing session remains the separate #19 contract. No implicit all-keys-to-all-workers option is introduced.

## Acceptance mapping

| Test | Contract |
|---|---|
| R10-DEPLOY-001 | Create-only output, pinned config, Core-only DB, scoped Worker secrets, no secret values in Compose, private output directory. |
| R10-DEPLOY-002 | Separate credentials per assigned Worker; missing opt-in, auth, profile, or duplicate profile fails before output. |
| R10-DEPLOY-003 | Service token file loader requires opt-in, refuses ambiguous direct/file values and unauthorized environment names. |
| R10-DEPLOY-004 | Generated APP_CONFIG and file-token bindings load through the actual Core configuration loader. |
| R10-DEPLOY-005 | Spawn the generated healthcheck against the real guarded HTTP server; the correct configured Host succeeds, ordinary incorrect Host remains 403. |
| R10-DEPLOY-006 | Symlinked output parents cannot place generated secrets inside the source tree. |
| R10-DEPLOY-007 | Credential sources inside the build/Git tree, including external aliases, are refused without copying. |
| R10-DEPLOY-008 | Directory, oversized and multiline credential inputs cannot generate a partial deployment. |
| multi-provider-compose / shared | Three independent non-root Worker containers, shared Ollama-format model, different personas, one concurrency scope, exact authenticated HTTP delivery, private memories and identities retained across Core recreation. |
| multi-provider-compose / mixed | Three independent non-root Worker containers, Ollama JSON / OpenAI-compatible schema / OpenAI-compatible ordinary text mode, separate models/keys/scopes, persisted injected 429 circuit and paused data after Core recreation. |

The application still requires structured action JSON even when transport-level JSON mode is `none`; ordinary mode means no Provider response-format parameter, not unstructured public output bypassing validation. The HTTP stubs return synthetic model responses. Existing schema, authentication, private-state, retry, transaction, browser, process and storage tests remain enabled.

CI artifacts contain aggregate synthetic proof only. Docker clusters are bounded test resources and are removed after the smoke; no real Provider, outside deployment, paid inference, registry publication or repository permission change is performed. Final head/runs and acceptance state are recorded in PR #40, not inferred from a successful diagnostic-display job.
