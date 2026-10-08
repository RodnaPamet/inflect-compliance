# 2026-10-08 — The legacy-access MCP client (Step 1b)

**Commit:** `feat(mcp): the legacy-access MCP client — pure transport, fails closed (Step 1b)`

## Design

`pullSnapshot` takes a URL, a token and some bounds, and returns rows or a typed
failure. No Prisma, no `RequestContext`, no tenant — Step 1c wires it to a provider and
Step 2a persists what it returns.

```
 initialize ──► notifications/initialized ──► resources/read (manifest)
                                                     │
                                         ┌───────────┴───────────┐
                                         │  for each advertised  │
                                         │  page, in order:      │
                                         │   parse the URI       │
                                         │   rebuild it with our │
                                         │     own projection    │
                                         │   read it             │
                                         │   snapshotId match?   │
                                         │   caps?               │
                                         │   oversharing?        │
                                         └───────────┬───────────┘
                                                     ▼
                                   { manifest, rows, complete, reason }
```

Three methods, ever. `initialize`, `notifications/initialized`, `resources/read` — and
`CLIENT_METHODS` exports that set so a test can assert the fake server's request log
against a closed list rather than against `!startsWith('tools/')`.

### The invariant that needed protecting

There is exactly ONE `complete: true` in the module, at the bottom of the happy path.
Everything else returns through a single `catch` that sets `complete: false` and reduces
the typed error to a `reason`. That shape was chosen because the failure mode here is
not an unhandled exception — it is a fault that reports `complete: true` anyway, and the
way that arrives is a new early return added later by someone who forgot the flag.

Returning a result rather than throwing is deliberate: a partial pull is a legitimate
outcome, and a caller that wants to say "we read 400 of 900 rows and then it tore" needs
the rows. The typed errors are still exported for a caller that prefers to catch.

### The body is never read uncapped

Not `res.json()`, not `res.text()` then a length check — both have already allocated the
whole body by the time you could measure it, which makes a byte cap a report rather than
a defence. `readCapped` pulls from the byte stream, counts as it goes, cancels the reader
and aborts the request the moment the count passes the cap.

`Content-Length` is used only as a free early refusal when it happens to be present and
already over. It is not the check: it is a claim by the party we are defending against,
and it is absent on a chunked response.

## Files

| File | Role |
| --- | --- |
| `src/lib/mcp/client/index.ts` | The pull: handshake, manifest, page loop, capped reader, the single `complete: true`. |
| `src/lib/mcp/client/errors.ts` | Six typed failures, one per operator action. None can carry a token or a row. |
| `tests/unit/legacy-mcp-client.test.ts` | 41 assertions: a clean pull as the control, then every fault, the token-leak sweep, the logging check and the structural rules. |
| `tests/guards/ssrf-egress-coverage.test.ts` | The client added to `SINKS`. |

## Decisions

- **Six error types, not one.** Each maps to a different operator action: tell the
  server's owner, retry, raise a cap, fix the URL, rotate the token, raise the deadline.
  Collapsing them is how a misconfigured URL and a wrong password become the same
  support ticket.

- **No error may carry the token or a row.** Every field is a count, an identifier, a URI
  or a short fixed phrase chosen from the code. The body is attacker-shaped — it came
  through a server an operator we do not employ is running — and an error message quoting
  it has moved untrusted content into `AuditLog.detailsJson`, which is plaintext,
  hash-chained and never deleted. The token half is proved by serialising every thrown
  error three ways and searching; the body half is structural, because no constructor
  accepts one.

- **`safeFetch` is called in an explicit branch, not resolved into an alias.** The first
  version was `const doFetch = ctx.fetchImpl ?? safeFetch`, and the SSRF sink registry
  caught it: `safeFetch(` never literally appeared, so the registry's "this sink calls
  safeFetch" check had nothing to match and was passing on the import alone. The branch
  also reads better — it shows that exactly one path reaches the network unprotected and
  that it is the test seam.

- **The advertised page URI is parsed, never requested verbatim.** The manifest says
  WHICH pages exist; the client rebuilds each URI with its own projection. A
  server-supplied URI is a server-supplied request target, and this client requests only
  what its own grammar can express.

- **A projection naming an undeclared column is refused before any page is requested.**
  Otherwise a server could invent the column and the oversharing check would accept it
  as requested.

- **Oversharing is refused, not filtered.** Silently dropping an unrequested column would
  make the server's oversharing invisible, and its owner is the only one who can fix it.

- **Tools are ignored, never refused.** A legacy server may legitimately expose tools for
  its own other consumers. What matters is that we never call one, which is a property of
  this client's method set rather than of the server's manifest — so the
  `toolsAdvertised` fault asserts a SUCCESSFUL pull plus an empty tools log.

- **A notification does not require a JSON content-type.** A conforming server answers
  `notifications/initialized` with a bodiless 202 and no content-type, so the
  `application/json` requirement sits below the notification return and applies only
  where a body is actually read. SSE is still refused for a notification: the contract
  forbids the transport, not just the payload.

- **A timeout is never retried.** The deadline exists because the pass has somewhere else
  to be, and the honest outcome of a slow server is no verdict, which leaves the accounts
  with a person.

## Two things the tests found that review would not

**The fake server ignores `AbortSignal`.** The first `slowResponse` test passed with
`complete: true`, because the double resolves late rather than rejecting on abort — so
the per-request timeout could not surface through it. The test now wraps it in a
signal-honouring fetch, which is what real `fetch` does. A double that cannot produce the
failing input grades nothing, and this one had been quietly grading nothing.

**Thirteen faults, not fourteen.** The step brief and three places in this file said
fourteen. The `FaultName` union has thirteen members, and the test's own denominator
assertion is what caught it — the set equality was green because both sides were the same
thirteen; only the magic number disagreed. It now asserts exactly thirteen, so deleting a
fault in Step 1a fails here too.

## Mutation proof

Five mutations, each restored byte-identical, against 51 assertions:

| Mutation | Failures |
| --- | --- |
| `complete: true` on every failure path | 15 |
| torn-snapshot check deleted | 2 |
| `res.text()` instead of the capped reader | 2 |
| bare `fetch` instead of `safeFetch` | 26 |
| oversharing check deleted | 1 |

The first is the one that matters: fifteen assertions stand between a fault and a false
claim of completeness.
