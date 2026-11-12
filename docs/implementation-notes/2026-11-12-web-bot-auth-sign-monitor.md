# 2026-11-12 — Web Bot Auth Phase 2: the bot seam signs the vendor monitor

**Commit:** `feat(web-bot-auth): one bot seam signs the vendor monitor and honours robots.txt (Phase 2)`

Phase 2 of `docs/ai-architecture/web-bot-auth.md`, first slice. The wire
format is the one `2026-11-11-web-bot-auth-decisions.md` records; the key
and directory are Phase 1's (`2026-11-11-web-bot-auth-key-directory.md`).

## Design

```
HeaderGradeTlsProvider.grade(domain)
  for each hop (≤ 5):
    origin not yet judged? ── botFetch(<origin>/robots.txt) ── RFC 9309
       disallow  → REFUSED, refusalReason ROBOTS (homepage never requested)
       5xx / net → UNREACHABLE (complete disallow)      4xx → no restriction
    botFetch(url) ── safeFetch ── 3xx: next hop, checked and signed afresh

botFetch(url, { method: GET|HEAD, signal, headers })     src/lib/web-bot-auth/bot-fetch.ts
  User-Agent: InflectCompliance-VendorMonitor/1.1 (+<APP_URL>/bots/vendor-monitor)
  deploymentBotSigner()  = webBotAuthDirectoryConfig() → current key + APP_URL authority
     null (no key, refused key, no https APP_URL) → unsigned, as before
     else signRequest() → Signature-Agent / Signature-Input / Signature
  safeFetch(url, …)       (https, public, pinned, no redirects)

signRequest({method,url}, key, {now, directoryAuthority, nonce?})   sign.ts, pure
  ("@method" "@authority" "@path" "signature-agent");created;expires=+60;
  keyid;alg="ed25519";nonce=<64 random bytes>;tag="web-bot-auth"
```

The sweep passes `refusalReason` and `signed` to
`vendor_monitor.tls_fetch{provider,outcome,reason,signed}` and writes
`tlsRefusalReason` into its `VENDOR_MONITOR_RUN` audit row.

## Files

| File | Role |
| --- | --- |
| `src/lib/web-bot-auth/sign.ts` | the request signer (closes Phase 1.2's open item) |
| `src/lib/web-bot-auth/bot-fetch.ts` | the seam: `botFetch`, the User-Agent, the deployment signer, the page's facts |
| `src/lib/web-bot-auth/robots.ts` | RFC 9309 parser and matcher, pure |
| `src/app-layer/services/vendor-monitoring/tls-provider.ts` | every request through `botFetch`; robots.txt per origin |
| `src/app-layer/services/vendor-monitoring/breach-provider.ts` | the bot's User-Agent from the seam (still unsigned) |
| `src/app-layer/services/vendor-monitoring/types.ts` | `TlsSignal.refusalReason`, `TlsSignal.signed` |
| `src/app-layer/usecases/vendor-monitoring.ts`, `src/lib/observability/integration-metrics.ts` | the metric's `reason` and `signed` labels; the audit row |
| `src/app/bots/vendor-monitor/page.tsx`, `messages/{en,bg}.json` | the public bot page |
| `src/lib/auth/guard.ts` | `/bots/vendor-monitor` in `PUBLIC_PATH_EXACT` |
| `eslint-rules/rules/web-bot-auth-single-seam.js`, `eslint.config.mjs` | the single-seam rule |
| `tests/guards/ssrf-egress-coverage.test.ts` | the seam replaces the TLS provider in `SINKS`; `BOT_SEAM_CALLERS` |
| `evals/web-bot-auth/records/2026-11-12-request-signing.json` | the G11 record, request half |
| `package.json`, `package-lock.json` | `web-bot-auth@0.2.0`, exact, devDependency |
| `docs/vendor-monitoring.md` | the identity paragraph and the registration runbook |

## Decisions

- **The seam is a function, not a provider option.** Callers cannot set the
  User-Agent or any signature header (refused, not overridden), and cannot
  choose the method beyond GET and HEAD. The tests' injection point is
  `deps.signer`; production never passes it.
- **The signer is resolved once per process.** Resolving per request would
  repeat the configuration's refusal log line on every fetch; the environment
  does not change under a running process.
- **The product token stayed `InflectCompliance-VendorMonitor`**, the string
  the monitor already sent, so a vendor that allowlisted it keeps working and
  its robots.txt group is the same; the version moved to 1.1 for the page link.
- **robots.txt is read once per ORIGIN per grade, not once per domain, and
  every hop is judged by its own path.** A homepage that redirects to `www.`
  is judged by `www.`'s robots.txt too, because RFC 9309 scopes a robots.txt
  to its origin. The text read for an origin is kept for the grade, and each
  URL about to be requested (a same-origin redirect to `/en/` included) is
  matched against it; judging only the first path on each origin, as the
  first cut did, followed `/` → `/en/` under `Disallow: /en/`.
- **Unreachable robots.txt requests nothing** (RFC 9309 §2.3.1.4) and records
  `UNREACHABLE`; a 429 on it is `REFUSED`; a recognised challenge on it is
  `REFUSED` without the ROBOTS reason, because a challenge is a door, not a
  policy.
- **`crawl-delay` is not honoured.** The decisions note put it to the owner as
  a proposal; it was not adopted, and the doc does not adopt it. The monitor
  sends one robots.txt and one homepage request (plus redirect hops) per
  check. A check is one monitor row in the 02:00 UTC sweep, or one on-demand
  `POST …/monitor/run` by a member with `vendors.edit`; two tenants
  monitoring one domain check it twice. The bot page says exactly that rather
  than "once per domain per day", which neither path keeps. Deduplicating by
  domain across tenants, or a per-domain floor on the on-demand run, is left
  open (below).
- **The reason is not a column.** It reaches the metric and the audit row; a
  migration for the vendor page was left out of this slice (below).
- **The breach check stays on `fetchWithRetry`, unsigned.** It is a fixed API
  host, not a website the monitor crawls, and the guardrail pins it to the
  shared retry helper. It now sends the bot's User-Agent, imported from the
  seam, so the rule's "token only in the seam" holds.
- **The conformance record is a snapshot the oracle signed off.** The test
  rebuilds it from fixed inputs (the RFC 9421 B.1.4 test key, a time, a
  nonce), re-asks the oracle for every case, and compares with the committed
  file, so a signer change fails CI until the record is regenerated
  (`UPDATE_WEB_BOT_AUTH_RECORD=1`) and the oracle agrees again. The oracle is
  a devDependency only (decisions note 0.3).
- **The lockfile entry was written by hand from an npm 10 resolution.** npm 10
  would also have stripped the `libc` fields that npm 11 writes; only the four
  new packages and the root devDependency were added.

## Significance, rollback and risk

SIGNIFICANT: it changes the edge's public-path allowlist (`guard.ts`) and adds
a devDependency. No migration.

- **Risk — signing.** Nothing signs until an operator sets
  `WEB_BOT_AUTH_SIGNING_KEY`; with it set, a signature only adds identity:
  every request is still `safeFetch`, and the tests prove the headers carry no
  tenant value under different tenant contexts.
- **Risk — robots.txt.** The monitor now makes one extra request per origin
  per check, and a vendor that disallows it stops being graded. That is the
  conduct D-L1-6 adopted; the outcome says why.
- **Risk — the allowlist.** One exact path is opened; the page reads no row.
- **Rollback.** Unset `WEB_BOT_AUTH_SIGNING_KEY` to stop signing at once.
  Reverting the commit returns the provider to direct `safeFetch` and removes
  the page; nothing persisted depends on it.

## Open

- **Fewer requests per domain.** Deduplicating checks of one domain across
  tenants in the sweep, and a per-domain floor on the on-demand run, so a site
  sees fewer requests than one pair per monitoring customer per check. The bot
  page states the current behaviour, not this.

- **The directory proof must also cover `content-digest`** before
  registration: Cloudflare's `http-signature-directory` validator requires it
  (decisions note), and the Phase 1 directory signs `"@authority";req` alone.
  The runbook's step 2 fails until then.
- The directory half of the G11 record (the validator against a CI-built
  instance) and a crawltest.com check, once reachable from CI.
- The breach provider onto `botFetch` (signed).
- A `tlsFetchReason` column so the vendor page can say "the site's robots.txt
  disallows the monitor" rather than a bare stale grade.
- An operator contact of its own on the bot page.
- 2.4 (registration, the operator's act) and 2.5 (the 14-day measurement).
- `crawl-delay`, if the owner adopts it.
