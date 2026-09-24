# Owner-scoped question understanding (#11)

## Public speech is not a shared semantic verdict

A public contribution has explicit `addressedTo` and `replyTo` links. These are routing/reference declarations, not proof that prose asks a question, that a named person is being addressed, or that a reply fully answers an earlier question. Human message input accepts an optional explicit `act`; omission remains an ordinary `comment`, even with addressees. This does not suppress natural-language questions: every participant still receives the public input and can independently recognize a question in a comment. The standard composer need not guess a speech act from punctuation or names.

Agent `Intent.act` remains its declaration. Public `question` contributions enter the existing question source index. An `answer` or `correction` declaration no longer writes a global `answered_by` verdict. Historical `answered_by` rows remain intact as legacy declared links; their presence does not remove a question from another Agent's current understanding. No old words or interpretations are recreated.

## Private assessment contract

An optional `question` field belongs to a `kind: question` entry in the existing owner-scoped private working state. Its fields are:

| Field | Meaning |
|---|---|
| messageId | The actual original being interpreted as a question. It may have public act `comment`. |
| status | `open`, `partial`, `awaiting_confirmation`, `resolved`, or `deferred`, according to this owner only. |
| addressing / addressedTo | `explicit` must exactly match original declared recipients; `inferred` is an owner's uncertain inference; `unknown` has an empty set. |
| replyIds | Observed originals supporting the answer assessment; partial/confirmation/resolved require at least one. A question cannot be its own answer. |
| topics | One to four non-exclusive owner-chosen labels, not delivery partitions or exclusive thread boundaries. |

Question and reply IDs must appear in that entry's message evidence with exact versions. Existing private-state completion checks require those originals to have actually been supplied in the recorded model context and still be current in the same session. A hint, an old state reference or an ID's existence alone does not establish present observation. Missing, foreign-session, deleted or wrong-version evidence is rejected. Explicit recipients cannot be changed by private interpretation; inferred recipients must belong to the same session. Duplicate assessments for one question in the same owner's active state are rejected.

Assessment, participation choice, journal, input cursor and candidate state binding use the existing atomic result transaction. Failed validation cannot leave a candidate published or a cursor acknowledged. Independent owners can disagree: C's `partial` or `resolved` never becomes B's private state or a global resolution flag. Semantic correctness is not independently certified by this structural validation.

## Hints, older questions and multiple topics

Context construction supplies source hints for the most recent eight declared public questions, regardless of recipient, plus the owner's actively retained interpreted questions. Explicit original recipients and private inferred recipients occupy separate fields. Status defaults to `unassessed` until this owner records an assessment. Text is an explicitly marked, at-most-160-character excerpt.

These hints are an index, not a claim that the full original was provided. The observation manifest still includes only actual messages, review differences and fetched originals. For an older question outside that set, bounded LOOKUP retrieves the original before the Agent may alter its assessment. Existing automatic owner-memory recall and source evidence remain active.

Working-state capacity stays at sixteen active entries, eight changes per result and the existing byte/input budget. Unrelated entries are not discarded when one question changes. More historical questions remain available in original messages, owner memory and private journals; this is not an unbounded hot index or a guarantee that every old question is simultaneously in a prompt. Model choices about retaining/removing/recalling topics require separate live quality evaluation.

All enabled participants hear public questions and replies, even A-to-B exchanges. C may listen, retain a partial understanding and later join. Topics do not restrict delivery. `DEFER answer_from` is a finite wait for a message, not proof of an answer and not a requirement that B respond. Existing finite reply grace, due time, budgets and Provider failure isolation allow C to become eligible when B remains silent or fails. No moderator, fixed speaker order, forced reply or compulsory closing question is introduced.

## Persistence, correction and disclosure

The field is optional, with no default rewriting old states. It is stored in the existing V6 private-state JSON and journal; no new table/schema migration is required. Current online backup/restore copies these records exactly. Editing/deleting a cited question or answer uses existing reference invalidation to remove the affected current assessment, retain its private audit journal and require reinterpretation; unrelated topic entries stay intact. Public exports and peer contexts do not include the private assessment. Public deletion is not forensic erasure of private audit records or backups.

Older binaries with strict private-state schemas may reject the new optional field. Roll back using a corresponding verified pre-update backup and binary, not by forcing `user_version` or stripping live state. Reading a V6 database with a newer binary is not permission to overwrite its private content.

## Acceptance evidence

`R6-QUESTION-000` first reproduces directed acknowledgements being misclassified as questions. `R6-QUESTION-001–006` exercise the real SessionService/SQLite result path: A/B/C interaction, partial versus resolved owner interpretations, explicit/unknown/inferred recipients, invalid evidence and rollback, overlapping topics, separate-directory backup/restore and source invalidation, finite waits under an addressed Agent failure, and an old interpreted question requiring actual LOOKUP.

`R6-QUESTION-007` uses three WorkerRuntime instances with separate scripted models and real authenticated loopback Core HTTP. It captures each owner's input, verifies C's partial state in C's subsequent request, checks that A/B and public export do not receive that private state, and exercises C's later publication through the normal atomic candidate path. Its prescribed test invocation sequence is not a production turn-order policy.

All data and model outputs are synthetic. Passing these tests demonstrates routing, state ownership, delivery, validation and persistence, not the accuracy of natural-language question identification/resolution. Actual conversation reading and semantic correctness remain #28. Candidate review continuity/fairness remains #12; repetition/natural conversation controls remain #13. Final-head CI and merge evidence must be recorded in PR #41; a draft or test count alone is not issue completion.
