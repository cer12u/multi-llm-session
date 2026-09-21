# Complete public archive navigation (#17)

The Web application uses the existing authenticated `history`, `search-page`, `threads` and `messages/lookup` contracts. It no longer treats the latest 200-message snapshot as the complete conversation. These are read-only projections: loading pages, reconnecting or opening a second display does not start a Worker or create an inference request.

## Operations

The toolbar above the conversation loads older messages in batches of 100. The first page remains the latest 200 for fast initial display. Loaded older pages remain available when a new snapshot arrives. The toolbar reports loading, the beginning of history, errors and explicit resynchronization. Scroll position is anchored to a message ID and its relative offset rather than only the old numeric scroll height. New messages do not force a reader away from an older position.

Search retrieves 50 results at a time, including matches outside the latest snapshot. A continuation cursor is tied to the query and edit generation. Edits/deletions invalidate that search membership: the application asks the user to restart from the beginning rather than silently skip results. Changing the query fences responses belonging to the prior query.

A reply panel obtains its persisted thread root from Core and retrieves 100 replies per page, including old nested replies. It is only a presentation grouping; it does not partition delivery to the session's Agents. Links of the form `/?session=<UUID>&message=<UUID>` open the authenticated session and retrieve history pages until the original is reached. They are not public access grants. Links remain usable for deleted-message tombstones, without restoring deleted text.

## Reconnection and concurrency

Messages are keyed by stable ID, ordered by stable sequence, and updated only by the same or a newer message revision. Loaded originals outside the latest snapshot receive sanitized SSE edits and tombstones. After missed updates the application revalidates loaded originals using batches of at most 200 IDs. When a disconnection spans more than a complete snapshot, it retrieves the missing intervening pages, rather than joining two ranges with a hidden hole. History/search/thread cursors are independent.

A stopped subscription, logged-out view or superseded search/thread request cannot publish a delayed response into the active view. Logout clears in-memory archive projections. The 390px layout and read-only viewer use the same archive contracts as the desktop operator. Private Agent state, persona definitions and credentials are not part of these projections.

The complete stored archive and the rendered selection remain separate. The implementation appends requested pages to the current view; it does not promise constant DOM or browser-memory cost after a user loads arbitrarily many messages. Switching/reloading can start from a fresh bounded snapshot without deleting stored history. Virtualized rendering may be added without changing the page contract. Deep-link retrieval can require many page requests; no additional model calls are used.

## Acceptance evidence

- `R7-HISTORY-001` in `tests/e2e/archive.spec.ts` exercises real HTTP/SQLite and Chromium with 1,205 original messages, 270 search matches, a 241-message nested thread, old-original navigation, an edit-invalidated search cursor, reading-anchor preservation, two windows and an offline deletion. It requires zero inference calls.
- `R7-HISTORY-002` exercises the same history pages as a read-only viewer at 390px, with no composer and no model calls.
- `R7-ARCHIVE-003–008` in `tests/archive-session.test.ts` connect the projection to real ArchivePages/SQLite, and add late-response fencing, search invalidation, explicit retry/resync, snapshot-gap recovery, tombstones and independent thread selection.

These cases use synthetic conversation data. Passing them establishes archive navigation and state invariants, not real-LLM conversation quality. Final-head CI and merge evidence must be recorded on PR #35. Durable draft/outbox restoration is tracked separately in #18; adding archive navigation does not by itself complete that requirement.
