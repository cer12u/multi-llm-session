# Durable drafts and uncertain submissions (#18)

## User-visible behavior

The main composer and each reply composer store their text and addressee on this browser device. Drafts are keyed by session ID and reply-root ID; changing a session or thread does not move a draft into another conversation. The status line distinguishes saving, saved, sending, unknown result, confirmed result, storage failure and another tab's conflicting version.

A submission is a separate immutable record containing the original text, reply target, addressees and idempotency key. That record is committed to IndexedDB **before** the message POST is made. The current editor may subsequently change without modifying that already-submitted record.

After a lost response or a reload during submission, the UI does not silently generate a new key. **送信結果を確認** reads the existing Core command receipt. A missing receipt is not proof that the old request will never commit. **元の内容を再送** therefore queries the receipt first and, only if still unresolved, sends exactly the original body/key. No timer automatically retries a human message. The ordinary new-submission button stays blocked while an older result is unresolved.

A confirmed response clears only the exact edit version that was submitted. An edit saved while that response was in flight remains in the editor. A deleted reply parent or an ended session makes the retained draft read-only and disables sending, while leaving its text available to select/copy. Empty ended-session composers remain hidden.

## Persistence and conflicts

The database is `multi-llm-session-drafts`, schema version 1, with `records` and `scopes` stores. Every record has a storage version and an editor version. A write checks the current storage version and logout generation inside the same read/write IndexedDB transaction. Two stale tabs cannot both overwrite that version. A conflict keeps the unsaved local text visible and requires explicit reload; users can copy their text before choosing the other tab's version.

Notifications use BroadcastChannel when available. They carry only an opaque namespace and draft key, not draft text or credentials. The version check in IndexedDB, not the notification, is the authority. Successful logout increments the namespace generation, so a previously opened tab cannot recreate an erased draft through a late write. Delayed result acknowledgment may reread a newer version, but it still clears only the exact submitted editor version.

Blocked/unavailable storage, malformed persisted data and quota failures are surfaced. Sending does not proceed if the original payload/key cannot first be persisted. Text still present only in memory after a reported write failure should be copied elsewhere before closing the page. The application does not silently clear an invalid database to get past an error.

## Ownership and shared devices

The existing application has **one operator principal per origin**, plus a read-only viewer. The draft UI is initialized only after the existing authentication response identifies that operator. IndexedDB allocates one random namespace for that origin's operator in a transaction; the namespace is not a token, credential, account identifier or authorization bypass. There is no new authentication endpoint, no credential-derived identifier and no server authentication change in this implementation.

Unauthenticated and viewer screens do not open the draft editor or display retained draft bodies. Losing authorization hides the editor without silently treating an uncertain submission as failed. Re-authentication as the application's operator can reopen the retained local state. Supporting several separate operator accounts would require a real server-side user identity and a corresponding storage migration; that is outside the current single-operator application contract and is not claimed here.

**The UI's explicit logout deletes all drafts and outbox records in this operator namespace on the device**, and notifies other tabs. A storage-clear failure is reported even when the UI hides the session. A server-side authentication expiry/revocation alone cannot erase a browser's offline files; it hides access until re-authentication. Shared-device users should use the UI logout, verify completion and, after a reported storage failure, clear the browser's site data.

No login token, Worker token, model API key, cookie or CSRF value is put in a draft record. The browser's ordinary origin/OS-profile security protects IndexedDB; this is not encrypted storage against someone who can inspect that OS/browser profile. Clearing records is application-level deletion, not a forensic erasure guarantee for disk snapshots, browser backups or copied text. Drafts remain local and are not included in public conversation exports or server database backups.

## Verification

`tests/e2e/drafts.spec.ts` uses actual Chromium IndexedDB, the real HTTP application and SQLite. It covers reload and tab reopening, addressee/IME behavior, a server commit whose HTTP response is lost, preserving an edited draft during receipt reconciliation, version conflicts between tabs, explicit logout/viewer isolation, and deleted/ended targets.

`R7-DRAFT-005–011` in `tests/draft-controller.test.ts` use a transactional storage fake and the real SessionService command/receipt path. They verify persist-before-send, stable keys, missing receipts, modified editors, version conflicts, logout fencing, write failures and late acknowledgments. They are not substitutes for the real-browser storage cases.

All test personas, messages and credentials are synthetic. No model calls are needed for draft restoration or these tests. PR #39 must record the actual final head and passing CI; the parent acceptance issue and real-LLM quality evaluation are separate.
