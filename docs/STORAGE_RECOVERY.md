# SQLite backup, restore and recovery acceptance

## Scope

The application remains single-host: only Core/SessionService writes live conversation state. This change adds an explicit storage-administration CLI, not another daemon or an HA system. The tested application schema is V5. The existing V1→V2→V3→V4→V5 migrations, current Agent state/journals, memory origins, observation/memory cursors, agenda, Provider circuit, messages and command receipts are preserved. Backups copy the complete SQLite snapshot rather than selecting a subset of tables.

Semantic memory reconciliation and new session membership behavior remain #9/#19. They are not implemented merely by backing up their current precursor tables. Any subsequent schema migration must update CURRENT_SCHEMA_VERSION, its required-object validation and populated migration/restore tests. Passing V5 recovery is not a claim that an unimplemented future schema was tested.

## Commands

Use the project's locked Node.js 24.20.0 environment and build first (`npm ci && npm run build`). Run commands as the account that owns the database and destination directory. Commands print schema, row counts, integrity and size metadata, not message bodies, persona or private state.

```sh
# Read-only inspection; a missing source is an error, not a newly created database.
node dist/apps/cli/storage.js inspect data/conversation.sqlite

# Core may stay online. The destination must not already exist.
node dist/apps/cli/storage.js backup data/conversation.sqlite backups/session-before-update.sqlite

# Restore into an entirely new path; this does not replace the live database.
node dist/apps/cli/storage.js restore backups/session-before-update.sqlite restored/session.sqlite
node dist/apps/cli/storage.js inspect restored/session.sqlite

# Stop Core and Workers before this command. Take a verified backup first.
node dist/apps/cli/storage.js maintain restored/session.sqlite --offline
```

The CLI does not require model credentials. These are filesystem-authorized operator operations, not new browser endpoints. The backup directory is private: it contains the same sensitive data as the original DB, including stored run contexts and journals.

## Consistent online backup

The backup uses SQLite's online backup API through a read-only source connection, so committed WAL data is included. Copying only an open `.sqlite` file is not an equivalent operation. Concurrent application writes can continue; the result is a consistent snapshot, not a promise to include every write that occurred before the command returned.

The source must already exist as a regular file with a supported schema, required application tables, a successful integrity check and no foreign-key violations. The operation does not migrate the source. A private mode-0600 temporary file is reserved in the destination directory, copied, checked, converted to a self-contained rollback-journal database and fsynced. A same-directory hard link publishes the completed file without replacing a concurrent destination. The directory is then fsynced.

This implementation and the CLI tests target Linux/local POSIX filesystems supporting hard links and directory fsync. Network filesystems, object stores and Windows durability behavior are not certified. Access to the parent directory must be limited to trusted operators; path resolution is not a security boundary against another user who can replace files in that directory.

`*.partial-*` files are not successful backups. Normal errors clean the attempt's own temporary files; abrupt process death can leave one behind. Inspect completed targets and clean only known stale temporary attempts. A failure after atomic publication may leave a valid destination even when the command exits unsuccessfully; inspect it rather than automatically overwriting it. Two concurrent operations to the same destination produce one completed file and one error, never an overwrite.

## Restore and restart

Restore also validates its source and creates a new destination. It does not delete the live database, rename files underneath a running Core, reuse old WAL files, change lifecycle, grant a new budget, or call a model. Stop Core and Workers before switching their configured DB_PATH to the inspected restored file. Retain the old database and corresponding backup until the restored state is checked.

For an initial recovery inspection use `RESTART_POLICY=paused` in the normal Core launch configuration. A RUNNING session otherwise follows the existing explicit restart policy; backup is not an implicit promise to leave every previously running session paused. Sessions stored as PAUSED/ENDED preserve that lifecycle. Core recovery fences unfinished runs, old worker/session generations and candidate validity. Finished idempotent command/result receipts remain authoritative. Re-register workers before resuming a session. Resume and budget renewal are separate operator actions.

Check public history/counts and identity, the owning private state and its version, memory-source links and search, cursor backlog, agenda state, Provider circuit and recorded command receipts before resuming live work. Keys are process/file configuration, not restored from profile rows. Do not mix keys into this CLI's output or public CI.

## Migration and rollback

An empty newly created application database is initialized normally. A user_version=0 database containing any foreign schema objects is refused before initialization, including views and table names similar to SQLite's reserved prefix. Migration/open failures close the connection and surface an error rather than deleting or recreating a database.

Each existing versioned migration is transactional. A migration failure leaves the last committed schema stage; this does not promise that several separate version transitions roll back as one transaction. Preserve the pre-upgrade backup. Correct an identified problem explicitly or restore that backup; do not alter production user_version or drop tables to force a binary to accept data. The tests that remove additive tables only construct synthetic older-version fixtures.

A binary rejects a newer schema. Rolling the binary back therefore requires its matching pre-upgrade backup, not merely copying the new DB back to the former pathname. Legacy unversioned memories retain their uncertain provenance. Information lost by past deletion/overwriting is not reconstructed or promoted into new facts.

## Maintenance and failure handling

`maintain --offline` rebuilds the existing FTS content from non-deleted primary messages, rebuilds indexes and VACUUMs without changing message IDs, insertion order, Agent ownership, state, stored memory, budgets or lifecycle. The flag is an explicit operator acknowledgment, not a process detector; it does not prove that Core has stopped. Do not run it against a live writer. Maintenance requires the current schema; inspect/backup/restore accept supported older schemas without migration.

The command checks database integrity and foreign keys, but these are structural checks, not a guarantee of semantic correctness of model-generated text. Insufficient capacity, unavailable destination, corrupt/incomplete input, unsupported schema and an existing destination remain errors. There is no fallback to a blank database. VACUUM and backup require temporary disk space in addition to the live file; determine available capacity from actual file/WAL/page sizes and filesystem availability rather than assuming a fixed compression saving.

## Retention policy

| Data | Default policy |
|---|---|
| Original public messages, stable IDs, sequence/thread relations | Retain. Prompt/page limits never delete records. Public tombstones do not imply erasing historic private records. |
| Private state and journal, memory and source versions, cursor receipts, agendas | Retain ownership and history. Explicit state removal is journaled; backup/maintenance never evicts records to fit a prompt. |
| Command receipts and finished/unfinished run accounting | Retain for idempotence and recovery. Do not prune independently of the operations that reference them. |
| Traces and operational records | Retain by default. Inspect growth; automatic age-based pruning/compression is not introduced here. |
| Completed backups | Operator-managed private rotation. Verify another recoverable copy before deliberately removing an old backup. Compress/copy only a completed snapshot and verify the decompressed copy before restoration. |

No secure erasure of private journals, old run contexts or backups is claimed. The wider export/erasure/authorization policy remains #23/#25. Production databases must not be uploaded to public Actions artifacts. Backup encryption, off-host replication and retention scheduling are deployment choices, not silently enabled network operations.

## Acceptance tests

| ID | Evidence |
|---|---|
| R10-STORAGE-001 | Unrelated populated table, SQLite-like table name and view-only V0 DB are not initialized. |
| R10-STORAGE-002 | Online backup while a writer stays open, separate-directory restore, exact private state/version, source origins, cursors, agenda, circuit and pause; idempotent command replay. |
| R10-STORAGE-003 | Missing, corrupt, unrelated/incomplete source and existing/self destination failures; no source initialization or destination replacement. |
| R10-STORAGE-004 | Rebuild/VACUUM retains 1,205 messages, 300 legacy memories and 1,000 trace rows with stable IDs/contents; records page/file/WAL size. |
| R10-STORAGE-005 | SQLite FULL through a constrained pager limit rolls back a write and retains originals; capacity recovery does not create a new DB. |
| R10-STORAGE-006 | Populated V2 migration failure leaves committed records intact, and an explicitly repaired synthetic fixture subsequently upgrades. |
| R10-STORAGE-007 | Three actual Core subprocess deaths: before transaction, after message insert inside transaction, after commit before HTTP/SSE notification; one logical command after replay. |
| R10-STORAGE-008 | Two actual Core deaths: after private-state write inside transaction and after completed state/action/cursor/agenda commit; rollback or one idempotent completed result. |
| R10-STORAGE-009 | Actual Worker subprocess death after call reservation and before result; no acknowledged input, lease recovery and one replacement result, abandoned remote slot retained. |
| R10-STORAGE-010/011 | Actual CLI inspect/backup/restore/offline maintenance, and concurrent no-replace backup publication. |

Fault tests require both SIGKILL and the marker written at the designated boundary; a startup/request timeout cannot count as a successful injected crash. All processes/databases are synthetic test-owned resources. Pager capacity tests are not disk-controller failure tests, and process death is not a power-cut/disk-corruption certification. Existing populated V1/V2/V4 migration and prior state/cursor/agenda recovery tests remain enabled.

CI saves `storage-restore-summary.json`, `storage-volume-summary.json` and `storage-crash-summary.json` under artifacts, with synthetic aggregate evidence only. File-size figures are observations of the named fixture, not a forecast of a year of live conversation. Long-duration operational/resource evaluation remains #29. Final-head CI and merge evidence are recorded in PR #37; a test count alone does not close the parent acceptance issue.
