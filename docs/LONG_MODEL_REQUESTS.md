# Long model requests

`requestTimeoutMs` now accepts 1000–900000 ms. Its default remains 90000 ms;
no saved session is rewritten and no existing live budget is extended. Set a
larger value explicitly in the normal session settings/config/experiment manifest.
The experiment's total duration, token/call/post limits and manual pause remain
separate limits. A long request does not authorize a later publication after stop.

The Worker uses the existing HTTP transport at 180000 ms and below. Explicitly
longer model requests use the model package's Node HTTP/HTTPS transport so an
independent fetch headers timeout does not preempt the configured model deadline.
The Worker's existing AbortSignal governs headers and body; connection establishment
still has a 15000 ms limit. A 910000 ms transport safety ceiling prevents an
unbounded direct use. Redirects are never followed, TLS validation remains enabled,
there is no automatic retry, and the existing decoded-response byte cap and model
output validation are unchanged. Standard response compression is decoded.

Core commands and heartbeat calls keep their short timeouts. Worker leases stay
short and are renewed through authenticated heartbeats, not extended to fifteen
minutes. The existing Provider reservation expiry uses the chosen request timeout
plus its 10000 ms accounting grace. Pause/generation changes still invalidate runs;
remote computation may continue, so cancellation is not a billing guarantee.

`deploy/long-request-e2e.mjs` runs the actual Core and three Worker processes against
a deliberately slow synthetic HTTP Provider. It waits 310 real seconds before
sending response headers, checks active renewable leases after 185 seconds and
single-slot reservation exclusion, then checks all three owners' state commits.
It also pauses with an actual request in flight, releases the obsolete answer,
checks no state/publication change, and resumes without losing retained state.
It performs no direct database writes or internal Service calls. Ordinary CI runs
this bounded E2E; it does not invoke a real model or use cloud credentials.

The separate real-model experiment uses existing `jsonMode: "schema"` and the
actual experiment CLI/Core/Workers/SQLite. Schema-valid text alone is not acceptance:
Core must still validate owner, version, observation and evidence IDs. Real-model
results, SHA, bounds and failures are recorded in issue #27; mock E2E success does
not establish model instruction following, conversation quality or long-term
live operation. No implicit switch to JSON mode, invented required fields or
relaxation of evidence validation is introduced.
