# 2026-08-22 — Edge rate limit on the CSP-report operator GET

**Branch:** `fix/csp-report-get-requires-admin` — follow-up to #2103.

Follow-up to `2026-08-22-csp-report-get-authz.md`, which closed the
disclosure on `GET /api/security/csp-report` by gating it on
`PLATFORM_ADMIN_API_KEY`. Adversarial review of that fix found the gate is
correct and *unmetered*: 500 consecutive wrong-key GETs returned 500 × 401
and zero 429.

## Design

Three limiters exist, and the path fell between all of them:

- `src/middleware.ts` early-returns `NextResponse.next()` for anything
  `isPublicPath` matches, and this path is on `MACHINE_CALLER_PREFIXES`
  (it has to be — a browser will not attach a cookie to a CSP report).
- `checkReportRateLimit` runs inside the `POST` handler only.
- `isApiReadRateLimited` answers `false` for anything outside `/api/t/`.

The middleware already had four surfaces with exactly this shape —
anonymous at the edge, credential verified in the handler, rate-limited
*before* the allowlist waves them through: `/trust/<slug>` (0),
`/api/trust/**` (0b), the device posture report (0c) and the external
vendor-assessment pair (0d). Section 0d's comment states the reason in so
many words: "the token check is constant-time but not free". This change is
a fifth entry in that series, not a new mechanism.

```
authMiddleware(req)
  0   /trust/<slug>                     → checkApiReadRateLimit(…, `trust:<slug>`)
  0b  /api/trust/**                     → …                     `apitrust:<slug>`
  0c  /api/t/<slug>/devices/report      → …                     `devreport:<tok>`
  0d  /vendor-assessment/**             → …                     `vendorassess:<id>`
  0e  GET|HEAD /api/security/csp-report → …                     `cspreport`      ← new
  1   isPublicPath(pathname)            → NextResponse.next()
  …
```

**Method scope.** 0e is the only one of the five that tests `req.method`, and
that is the load-bearing part. The `POST` on this path is a credential-less
browser beacon; a limiter it shares with an attacker drops real violation
reports, silently, which is the precise failure the whole credential-less
design exists to avoid. So the block covers `GET` — and the `HEAD` that
Next.js derives from an exported `GET`, which runs the same handler — and
leaves `POST` to fall through to the allowlist byte-for-byte as before, with
its own 30/IP/min in-handler limiter and 16 KB body cap.

**Key.** `checkApiReadRateLimit(req, null, 'cspreport')` — the client IP is
folded into the bucket by the enforcement module, and `userId` is null
because no JWT has been read at this point in the middleware. Deliberately
*not* keyed by the presented credential the way 0c keys by the device bearer
token: a device token is issued, so keying by it gives each device a fair
bucket behind one NAT, whereas here the credential is the thing an attacker
varies — keying by it would hand every guess a fresh budget. There is a test
for that specific inversion.

**Budget.** `API_READ_LIMIT`, 120/min, the same preset the other four use.
Worth being explicit that this number is not sized against guessing: the key
is 32+ characters compared in constant time, so the search space is the
control there and no rate limit meaningfully adds to it. What 120/min buys is
a bound on cost — an unauthenticated caller can spend 120 constant-time
compares plus summary serialisations per IP per minute instead of an
unbounded number. Operator use of the endpoint is a human refreshing a debug
view, single digits per minute, so the ceiling is roughly two orders of
magnitude above real demand and there was no reason to invent a tighter
bespoke preset.

## Files

| File | Role |
|------|------|
| `src/middleware.ts` | Section 0e — the edge block, before the public-path early-return |
| `src/lib/security/csp.ts` | `LEGACY_CSP_REPORT_PATH`, so the alias is named rather than spelled inline |
| `docs/rate-limiting.md` | New "Anonymous edge surfaces" section covering all five |
| `tests/unit/security/csp-report-get-rate-limit.test.ts` | Behaviour, both directions |

## Decisions

- **The legacy alias `/api/csp-report` is covered too**, even though it
  exports only a `POST` forwarder today and a `GET` there is a 405. The two
  paths are one surface at the edge: they are adjacent entries on the same
  allowlist, added for the same reason. Covering only the canonical one means
  the day anyone exports a `GET` from the alias, the alias is the unmetered
  way in and nothing says so.
- **On the allow side it falls through instead of returning
  `NextResponse.next()`**, which is the one place it departs from 0–0d.
  Behaviour today is identical — `isPublicPath` matches this path on the very
  next line. What it buys is that `MACHINE_CALLER_PREFIXES` stays the only
  thing making the path public at the edge, which is exactly what `guard.ts`
  claims of it. A `next()` here would be a second, silent authority: removing
  the allowlist entry would then close the POST (every report lost) and leave
  the GET open, the inverse of what anyone editing that list would intend.
- **No source-scanning ratchet.** The behavioural test already fails if the
  block is deleted (9 of 11 tests), if it is moved below `isPublicPath`
  (same 9), or if it is widened to cover `POST` (2 tests, from the other
  direction) — all three verified by mutation. A regex over `middleware.ts`
  would add nothing the outcome tests do not already catch, and would fire on
  reordering and renaming.
- **Fail-open is inherited, on purpose.** `checkApiReadRateLimit` returns
  `{ ok: true }` when Upstash throws. A Redis outage therefore restores the
  pre-change posture on this path rather than taking the operator's debug
  view offline during an incident — which is when it is most likely to be
  wanted.
