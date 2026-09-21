# Owner-selected agendas (#7)

An entry in `self.privateState.entries` may carry a `resume` condition. This now registers a durable, private, **one-shot opportunity to reconsider**, not a command to speak. Ordinary decide/draft/review outputs still choose SPEAK, DEFER, ABSTAIN or DROP; no fixed turn order, minimum utterance count or moderator is introduced.

## Conditions

`time` uses an absolute Unix time in milliseconds (`notBefore`). It is delayed to at least creation time plus `settings.agendaMinIntervalMs` (default 30 seconds), and is gated by `selfWakeEnabled`. `new_message` matches another participant's public message/change. `answer_from` matches the selected participant's message/change, not a mention of their name. It does not assert that the question has been semantically answered. `related_topic` matches a case-insensitive NFKC-normalized literal phrase in other participants' messages or available source title/body. It is a deterministic trigger, not semantic similarity; the Agent can also reconsider related wording during normal observation. Conditions never read another session or another Agent's private state.

`Context.agenda` reports requested/effective times, pending and triggered plan IDs, matched input/version, and disabled/budget/minimum-interval reasons. It is included before input budgeting and observation-manifest binding. It is supplied only to the owner; operator diagnostics can inspect scheduling metadata. Public snapshot/SSE/transcript do not include private entry or plan IDs. See exported `agenda.schema.json` and `agendaSignal.schema.json`.

## State machine and transactions

`PENDING → TRIGGERED → CONSUMED`, with `CANCELLED` for withdrawal, replacement or session end. A stable binding connects each current private entry to its plan. Keeping the same condition, changing unrelated state, retransmitting a result or restarting a process does not rearm a consumed plan. To rearm, change the condition or explicitly remove it in one completed update and add it in a later update. Timed rearming cannot bypass the minimum interval. Trigger cohorts share the owner's persisted wake clock.

Successful state/action, input cursor, agenda acknowledgment and run completion use one SessionService transaction. An invalid patch cannot leave a scheduled job behind. Only triggered plans present in a completed participation input are consumed; observe-only/memory runs and incomplete review windows do not consume them. An opportunity that arrives during a run remains pending for a subsequent input. One dispatch sets the persisted notification flag and wake generation together. A crash after dispatch but before completion replays the outstanding opportunity in a new fenced run, without creating a second plan.

The original matched source version is checked again. An edited/deleted match rejects an old participation result; scanning resumes after the old matching input so a new source version is evaluated explicitly. Directly invalidated private entries cancel their bound plans on the next Core tick. The input scan uses bounded pages and continues from a durable cursor.

## Lifecycle, errors and budgets

Core alone dispatches; browser presence, reconnects, UI redraws and diagnostics do not drive execution. Paused sessions retain plans without dispatch. Disabled Agents do not dispatch; explicit re-enabling retains their outstanding intentions. Ending a session cancels outstanding plans permanently. Restart recovery preserves the operator's pause policy and generation fencing.

Agendas do not clear Provider/Agent errors, renew a call/time/message budget or resume an operator-paused session. Existing call reservations and final publication limits apply. A timed plan outside the current remaining active-time allowance is reported as `OUTSIDE_CURRENT_BUDGET` and retained; budget renewal remains a separate explicit operation. Setting `selfWakeEnabled:false` disables timed agenda dispatch as well as generic autonomous ticks, but still permits observed input/source conditions. Existing generic SELF_WAKE and once-per-silence-interval IDLE opportunities remain distinct from owner-selected AGENDA.

An AGENDA opportunity can release the owner's current DEFER to reconsider the retained question; unrelated messages continue through observe-only processing without clearing a timed deferral. It still does not force public speech. Provider failure is not normal silence.

## Migration and verification

SQLite V4→V5 adds `agent_agenda`, `agent_agenda_bindings`, and `agent_agenda_clock`, fences active old runs and requires ready candidates to be reviewed. It does not modify saved limits or delete conversation, memory, state or receipt rows. Existing stored resume conditions are bound when the running Core first reconciles them; past input is not falsely treated as a newly observed match. Stop Core/Workers and back up before upgrading. A V4 binary requires the pre-upgrade database backup for rollback, not a manually changed version number.

`R3-AGENDA-001` is the regression committed before integration. `tests/agenda.test.ts` adds withdrawal/replacement, no rearming on replay, deferred observation/source wake, author-versus-mention, self/viewer isolation, stable silence, pause/disable/end, disabled time/call/active-time gates, restart before acknowledgment, edited matches, multi-page scanning, atomic foreign-owner rejection and minimum-interval tests (R3-AGENDA-002–015). Populated V1/V2 migrations remain covered. These are synthetic control tests, not real-LLM topic selection or natural-conversation quality. Final CI evidence belongs to the exact tested PR head. #9–#13, UI/operations and real-model evaluation remain separate.
