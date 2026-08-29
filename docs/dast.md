# Dynamic Application Security Testing (DAST) — OWASP ZAP

The repo's security gates were entirely **static** (CodeQL SAST, Trivy
container CVEs, npm audit, RLS, Epic A–F runtime hardening). DAST adds
the missing **dynamic** layer: it boots the real running app and probes
it over HTTP the way an attacker would.

Workflow: `.github/workflows/dast.yml` — nightly `0 4 * * *` (off-peak,
after the 03:30 load test) + `workflow_dispatch`.

## What the Baseline scan is (and isn't)

We run the **ZAP Baseline** scan, which is **passive**: ZAP spiders the
app and inspects the responses it gets, but does **not** mutate requests
or inject payloads. It catches:

- Missing/weak security headers (CSP, X-Content-Type-Options, HSTS, …)
- Cookies without `Secure` / `HttpOnly` / `SameSite`
- Cacheable sensitive content, information disclosure, verbose errors
- Mixed content, clickjacking exposure, server banner leakage

It does **not** catch active-exploitation classes — **reflected/stored
XSS, SQL injection, command injection, auth-bypass via mutated
requests**. Those need the **Full (active) scan**, ZAP's destructive
sibling, which fuzzes inputs + submits forms. That now runs as a
**separate WEEKLY workflow** (`.github/workflows/dast-full.yml`,
`zaproxy/action-full-scan`, Sundays 05:00 UTC + dispatch) — authenticated
as OWNER, non-blocking for Medium-and-below during roll-in (a HIGH
still fails it), SARIF category `zap-full`. It is
SAFE because it only ever targets the **ephemeral CI app** (fresh seeded
Postgres, no real data, no SMTP, rate-limiting off) — never a real env.

### Coverage

- **Authenticated as OWNER.** A pre-scan step performs the real NextAuth
  v4 credentials login (`GET /api/auth/csrf` → `POST /api/auth/callback/credentials`
  with the `admin@acme.com` seed user) and hands ZAP the resulting
  `next-auth.session-token` cookie via its header-injection env vars
  (`ZAP_AUTH_HEADER`/`_VALUE`/`_SITE`) — `action-baseline` has no
  context/auth inputs, so header injection is the only mechanism, and a
  `.zap/zap-context.xml` is **not** used. The scan therefore covers both
  the public surface (login/register/forgot-password/health) AND gated
  `/api/t/<slug>/**` + `/t/<slug>/**` routes as a logged-in OWNER. The
  login step fails loudly if the session cookie can't authenticate
  `/api/auth/me`, so a broken login never silently degrades to an
  unauthenticated scan.
- **Multi-role matrix.** The scan runs once per seeded role
  (OWNER `admin@acme.com`, EDITOR `editor@acme.com`, READER
  `viewer@acme.com`, AUDITOR `auditor@acme.com`) — each logs in
  separately and scans that role's reachable surface, with a per-role
  SARIF category (`zap-baseline-<role>`), issue title, and artifact.
  The four jobs run in parallel (≈ single-scan wall-clock, ~4× runner
  minutes). No distinct ADMIN-role seed user exists, so OWNER covers
  the admin tier. **This is per-role PASSIVE surface coverage, NOT
  automated broken-access-control detection** — a READER session here
  scans what a READER can reach, but ZAP baseline does not assert "a
  READER must be *denied* a create route." That BAC invariant is
  enforced + tested at the app layer (`tenant-crud-authz-parity` unit
  test + `requirePermission` gates + e2e); true DAST BAC detection
  would need ZAP's Access Control add-on (Automation Framework) — a
  separate future investment.

## Reporting

- **Security tab** — the scan's JSON report is converted to SARIF
  (`.zap/zap-json-to-sarif.mjs`, dependency-free) and uploaded under a
  per-role category `zap-baseline-<role>`, alongside CodeQL + Trivy.
- **Artifact** — `report_html.html` (+ md/json) is uploaded as
  `zap-baseline-report-<role>` (7-day retention) for human triage.
- **Auto-issue** — on findings, `zaproxy/action-baseline` opens/updates
  a GitHub issue titled "ZAP Baseline Findings — `<role>` (nightly)"
  (its built-in `allow_issue_writing`; we do not roll our own).

## Triaging a finding

1. Open the HTML artifact (or the auto-issue / Security-tab alert).
2. Identify the **URL** + the **rule code** (e.g. `10038` = CSP header).
3. Decide: **genuine** or **false-positive**?
   - **Genuine** → fix the app (add the header, set the cookie flag,
     stop caching the sensitive route, …). Re-run `workflow_dispatch`.
   - **False-positive** (framework behaviour ZAP can't see, intentional
     design) → add the rule id to `.zap/rules.tsv` as `IGNORE` **with a
     one-line `#` reason** (the `dast-workflow-pinning` guardrail
     requires the reason). Prefer `WARN` over `IGNORE` when you want it
     visible-but-non-failing.

**An `IGNORE` covers Medium and below — never a High.** A pluginId entry
silences that rule at every ZAP risk level, which is right for the
framework false-positives the allowlist was built for and wrong for a
High. So `.zap/assert-no-high-risk.mjs` runs after every scan and reads
the report's `ignoredAlerts` as well as its live `alerts`: a High or
Critical fails the job whether or not a rules.tsv line covers it. A HIGH
is fixed, not allowlisted.

**One id, several alerts.** A pluginId matches every alert the rule
emits, including differently-named sub-alerts — `10055` alone covers
"CSP: Wildcard Directive", "CSP: style-src unsafe-inline" and "CSP:
Notices". Name each accepted sub-alert in the reason column, or the
entry silently grows scope the next time ZAP splits a rule.

`.zap/rules.tsv` is the single allowlist. Seeded with three well-known
Next.js false-positives (10202 anti-CSRF, 10049 cacheable `/api/health`,
10027 build-manifest comments).

### Initial findings triage (first nightly pass)

The first authenticated runs surfaced six header findings (FAIL-NEW: 0
— all WARN/INFO). Triage:

- **10037 Server Leaks Information via X-Powered-By → FIXED.**
  `poweredByHeader: false` in `next.config.js` drops the header.
- **10055 CSP wildcard, 90004 COEP missing, 10038 CSP-not-set,
  10109 Modern Web App → ACCEPTED (IGNORE, with reasons in rules.tsv).**
  These are deliberate/required design choices, not gaps:
  - `img-src`/`connect-src` use the `https:` scheme-source on purpose —
    narrowing to explicit hosts would break OAuth avatars, Sentry,
    Upstash, Stripe, OTel, HIBP, … . The load-bearing `script-src` is
    strict (nonce + strict-dynamic, no `unsafe-inline`).
  - COEP `require-corp` would **block the cross-origin OAuth-provider
    avatar images** — so COEP is intentionally omitted (COOP + CORP are
    set). Enabling it would regress the avatar feature.
  - CSP-not-set only on the static files excluded from the middleware
    matcher (robots/sitemap/favicon) — CSP is meaningless there.
- **10019 Content-Type missing → ACCEPTED (IGNORE).** Triaged from its
  initial WARN after confirming the only offending responses are the
  **bodyless redirects** `GET /` and `GET /dashboard` (30x, no body → no
  Content-Type is correct). Risk 0 (informational); `X-Content-Type-Options:
  nosniff` is set globally regardless.
- **10099 Source Code Disclosure - SQL → ACCEPTED (IGNORE), false positive.**
  The passive rule matched the plain-English session-management microcopy
  *"Revoke any device to sign it out on its next request."*
  (`admin/members` page) — a bundled i18n string, **not** SQL source code.
  It fired identically on `/`, `/login`, and the 404s served for
  `robots.txt`/`sitemap.xml` because it is the same shared JS chunk ZAP
  reads on every response, which is the tell of a regex false-match rather
  than a per-endpoint leak. No SQL, no source disclosure. With this, the
  nightly baseline is **WARN-NEW: 0 / FAIL-NEW: 0** — a clean, stable
  allowlist.

The takeaway: the app's CSP is already strong; the remaining findings
are accepted trade-offs documented in `.zap/rules.tsv`, not changes to
make. (Tightening them would break functionality — the opposite of
hardening.)

## Gating posture

**Nightly baseline — BLOCKING since 2026-08-29** (`fail_action: true`,
no `continue-on-error`). Two independent gates can fail the job:

1. `fail_action: true` — any alert **not** listed in `.zap/rules.tsv`.
2. the **Fail on HIGH+** step (`.zap/assert-no-high-risk.mjs`) — any
   High/Critical alert, *including* one an `IGNORE` line covers.

Dropping `continue-on-error` is load-bearing beyond the findings
verdict: `action-baseline` calls `core.setFailed` on `zap-baseline.py`
exit code 3 ("could not scan the target") regardless of `fail_action`,
so `continue-on-error` was also masking a scan that never ran as a green
nightly. A green run now means a scan actually happened.

**Weekly full scan — deferred for Medium and below until 2026-10-11**,
because the active scan's findings baseline is younger (11 runs, 2 lost
to boot/runner flake). A High is *not* deferred: the same HIGH+ step
runs there today.

**How a deferral works.** A non-blocking scan must carry a
machine-readable marker in its workflow file:

```
# DAST-NON-BLOCKING-UNTIL: YYYY-MM-DD — <written reason>
```

`tests/guardrails/dast-workflow-pinning.test.ts` parses that date and
compares it **against the real clock**, failing the day after it passes,
and rejects a date more than 180 days out. A scan with no marker must be
blocking. So a deferral cannot outlive its own deadline unnoticed.

> **Why the mechanism is shaped this way.** The original 30-day window
> closed on **2026-07-24** and the flip did not happen for another 36
> days. The guard that should have caught it only grepped for a comment
> containing *some* date — it never parsed or compared one, so it was
> structurally incapable of failing while reading, in CI, as coverage of
> exactly that deadline. The date comparison above is now exercised
> against fixed clocks in the guardrail, so an all-green population
> cannot be mistaken for a check that never ran.

### Flipping a scan to blocking

Do it only on evidence, not on the calendar: pull the recent runs'
`report_json.json` artifacts and confirm **zero un-allowlisted alerts**
(`site[].alerts` empty) and **zero HIGH+** across every role. Then drop
`continue-on-error`, set `fail_action: true`, and delete the marker in
the same diff — the guardrail fails on a stale marker left beside a
blocking scan.

## Roadmap

1. ✅ **Authenticated-OWNER baseline** — NextAuth CSRF login → session
   cookie via `ZAP_AUTH_HEADER*` (header injection; no context file).
2. ✅ **Multi-role scan** — OWNER/EDITOR/READER/AUDITOR matrix (per-role
   surface coverage; BAC itself is enforced + tested at the app layer).
3. ✅ **Weekly Full (active) scan** — `.github/workflows/dast-full.yml`.
4. ✅ **Baseline blocking** — flipped 2026-08-29 on evidence of a
   stable allowlist (0 un-allowlisted alerts, 0 HIGH+ across all four
   roles), with the sunset check rebuilt to compare against the clock.
5. ⏳ **Flip the weekly Full scan to blocking** on its
   `DAST-NON-BLOCKING-UNTIL: 2026-10-11` marker, once the active scan's
   findings are triaged against the shared allowlist.
