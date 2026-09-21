# Character and presentation boundaries

## Character management (#14)

An operator opens **キャラクターを管理** in the sidebar. The ordinary form accepts ID, display name, persona/background/speaking style and an optional presentation reference. Saving creates an immutable version. The catalog shows latest, currently viewed and next-save versions, along with the version pinned to the selected session. Viewing an old version and saving creates a new latest version, not an overwrite.

Create, edit, JSON import, validation, exact-version export, listing and detail use the same CharacterSchema and CharacterCatalog as the HTTP API. Importing an identical ID/version is idempotent. Importing changed content under that pair is rejected. Unknown fields are rejected. Different IDs with the same name remain different characters; separate session Agent instances never share private working state automatically.

New sessions use the latest stored definitions. Existing session snapshots and historic speaker identities are unchanged when the catalog changes. This change does not implement applying a new persona in-place to an existing paused session (#19). The UI states that limitation before saving. Definition hashes and the actual selected persona remain available in the owning model input and existing run records; this proves version selection, not personality quality.

| Endpoint | Meaning |
|---|---|
| GET /v1/characters | Latest definitions for operator; public identity fields only for viewer |
| POST /v1/characters | Existing immutable save route |
| GET /v1/characters/:characterId/versions | Version index with hashes |
| GET /v1/characters/:characterId/versions/:version | Exact definition and hash |
| GET /v1/characters/:characterId/versions/:version/export | Exact definition JSON |
| POST /v1/characters/validate | Validate without storing or invoking a model |
| POST /v1/characters/import | Validate and store an exact version |

All added routes are operator-only; cookie-authenticated writes also require the existing Origin and CSRF checks. Host validation, logout revocation, body limits and immutable-version checks are unchanged. API/model credentials are not part of a character. The optional presentation reference is stored as a string: it does not fetch URLs, execute scripts, or install an adapter. The text avatar/name remains the fallback.

## CharacterProvider (#21)

`packages/characters/index.ts` defines `load({id, version})`. A provider can return a Character or a promise. `resolveCharacter` validates both schema and exact reference; a different ID/version is rejected. `LocalCharacterProvider` loads JSON definitions. `CharacterCatalog` exposes the same interface over immutable SQLite definitions and imports a replacement provider without holding a database transaction over asynchronous I/O.

The Core registration uses CharacterCatalog and LocalCharacterProvider. Workers receive the selected session snapshot, not an adapter object. Replacing acquisition does not change Agent identity, inference Provider or presentation. CharacterProvider implementations are trusted application code, not arbitrary code received in a character file.

## PresentationAdapter (#21)

`packages/presentation/index.ts` defines `handle(publicEvent): void | Promise<void>`. The event contract is schemaVersion 1. A legacy Core event without an explicit version is normalized to 1. Unknown future schema versions are rejected. Unknown fields, including nested private/configuration data, are stripped rather than spread to the adapter. Only public message identity/text/revision and coarse Agent status are allowed. Deleted text is blanked even if supplied accidentally.

The presentation DTO is intentionally narrower than the internal event row. It excludes persona, private state, run token, draft/candidate, memory, credentials and arbitrary event data. `publicPresentationEvent` is the required decoder. Exported JSON Schemas describe structural fields; session/cursor ownership and deletion redaction are additional runtime checks.

The actual Web `subscribeSession` takes an optional fourth argument `{adapter, adapterTimeoutMs}`. Its ordinary text/snapshot path is always active, even with no enhancement, invalid extension data, adapter failure or a pending promise. A renderer gets a separate sanitized copy and no command/worker API object. No presentation ACK is stored as a message, and no publication transaction waits for a renderer.

One dispatcher is bound to one session. Its cursor is `session UUID:event sequence`, not the message revision or message sequence. Delivery is ordered; duplicates and older events are ignored. Each reconnect first acquires a fresh authoritative snapshot and seeds a new dispatcher from that snapshot cursor. The cursor tracks delivery to the view, not durable completion of an external renderer. The initial snapshot/history is rendered by the text view; an enhancement receives subsequent events, not a synthetic replay of old utterances. Full archive UI is still #17.

Enhancements are best-effort: at most one asynchronous call is in flight, with no backlog queue. While busy, text continues and new enhancement events are skipped. Rejection, synchronous error or timeout (default 1 second) disables that enhancement until a new connection. A synchronous function that blocks JavaScript cannot be preempted; extensions must cooperate and must not perform expensive synchronous work. A late promise cannot cancel text or write to Core. Disposal clears timers; arbitrary external effects already begun by a trusted extension cannot be undone.

### Minimal integration

```ts
import { subscribeSession } from '../apps/web/src/event-stream.js';
import type { PresentationAdapter } from '../packages/presentation/index.js';

const accessory: PresentationAdapter = {
  handle(event) {
    // Use textContent, never innerHTML. Do not fetch presentationRef as executable content.
    if (event.message) document.getElementById('accessory')!.textContent =
      event.message.deleted ? '（削除済み）' : `${event.message.authorName}: ${event.message.text}`;
  }
};
// loadSnapshot and renderSnapshot are the same authorized read-only functions used by the text UI.
const stop = subscribeSession(loadSnapshot, renderSnapshot, showConnectionStatus, { adapter: accessory });
// Dispose when the view/session is replaced.
stop();
```

The sample's application callbacks and DOM element are supplied by its host. No VRM, Live2D, TTS, external Slack/Discord connection or Character Card standard is claimed.

## Acceptance evidence

R9-CHAR-001 tests exact versions/import/export, frozen sessions and viewer denial through the registered HTTP application. R9-CHAR-002 checks interchangeable asynchronous providers and corrupt/mismatched references. R9-CHAR-003 tests Host/Origin/CSRF, validation without mutation, duplicate import and logout. R9-CHAR-004/005 are actual Chromium form/import/download/reload and 390px/viewer tests, not static component tests.

R9-PRESENT-001–005 test two adapters, replay, private-field filtering, tombstones, cross-session IDs, throw/rejection/hang behavior and no additional calls/commits. R9-PRESENT-006 uses actual SessionService snapshots/events through the Web subscription with a synthetic EventSource and a hung adapter, including reconnection and old-listener fencing. Existing multi-window browser cases and Core/Worker suites remain enabled.

Passing results must be attached to the final PR head. These tests use synthetic data; they are not real-model personality/conversation evaluation. #4 and other pending acceptance issues remain open.
