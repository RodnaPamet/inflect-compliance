# 2026-10-31 — The vendor monitor's TLS grade goes through the SSRF guard

**Commit:** see the pull request that adds this note.

## Design

Anybody who can edit a vendor types its domain, and the nightly
vendor-monitoring sweep requests `https://<domain>` from inside the deployment
to grade the homepage's security headers. `HeaderGradeTlsProvider` made that
request through `fetchWithRetry`, the plain global `fetch` with retries:

- no address check, so `169.254.169.254`, `localhost`, `10.0.0.5` or a public
  name resolving into private space was requested like any other host;
- redirects followed wherever they led, up to 20 hops;
- the domain pasted into the URL as typed, so `host:6379`, `user@host` or
  `host/path` shaped the request.

The response was never shown, only graded, so this was a blind SSRF. The grade
still differed by which headers the internal service answered with, which is
enough to probe the deployment's network. The Web Bot Auth roadmap found it
(sub-phase 0.5).

The provider now does this:

```
vendor domain ──► vendorHomepageUrl: bare host name, or nothing
              ──► safeFetch(GET, timeout)       https · public address · pinned · no redirect
                    ├─ 2xx            → grade the headers, discard the body
                    ├─ 3xx (thrown)   → resolve Location → safeFetch again (≤ 5 hops)
                    ├─ 429/5xx/network → one retry inside a 20 s deadline
                    ├─ other status   → ungraded
                    └─ SsrfBlockedError → ungraded, logged with the reason
```

`SimpleMetadataProvider`, an unreachable homepage scraper in
`vendor-enrichment.ts`, made seven bare `fetch` calls on the same
tenant-entered domain. It was deleted (sub-phase 0.6, its default).

## Files

| File | Role |
| --- | --- |
| `src/app-layer/services/vendor-monitoring/tls-provider.ts` | `vendorHomepageUrl`, the per-hop `safeFetch` loop, the bounds |
| `src/app-layer/services/vendor-enrichment.ts` | `SimpleMetadataProvider` deleted; `getEnrichmentProvider()` takes no name |
| `tests/unit/vendor-tls-grade-egress.test.ts` | real `safeFetch`, DNS and transport stubbed; the global `fetch` throws |
| `tests/guards/ssrf-egress-coverage.test.ts` | `tls-provider.ts` joins `SINKS` |
| `tests/guardrails/vendor-monitoring-coverage.test.ts` | stopped requiring `fetchWithRetry` in the TLS provider, which pinned the hole |
| `docs/vendor-monitoring.md`, `docs/ai-architecture/web-bot-auth.md`, `docs/ai-architecture-roadmap.md` | current state; sub-phases 0.5 and 0.6 checked |

## Decisions

- **Follow redirects here rather than refuse them, as `safeFetch` does.**
  `safeFetch` refuses a redirect because its other callers POST signed bodies
  that must not reach a destination nobody configured. A homepage GET carries
  no body and no credential, and `acme.com` → `www.acme.com` is normal.
  Refusing would leave most vendors ungraded, and silently, because an
  ungraded result keeps the old grade. Every hop is a fresh `safeFetch`, so
  the target gets the same https, public-address and pinning checks as the
  first URL. `safeFetch` itself is unchanged.
- **A bare host name or nothing.** A port, credential, path, query, fragment,
  `%` or scheme in the domain field leaves the vendor ungraded, rather than
  being normalised. This rejects an `https://acme.com` typed into the domain
  field, which the old code also failed on, because it built
  `https://https://acme.com`. Write-time validation was not added: the field
  is free text with existing rows, and the check that matters has to run at
  use time anyway, against DNS rebinding.
- **The breach check stays on `fetchWithRetry`.** Its host is the fixed HIBP
  endpoint named in code, with the domain URL-encoded into the query. G6
  admits code-constant hosts, so it is not an SSRF sink.
- **A 403 is no longer retried.** `fetchWithRetry` retried it, which only
  doubled the requests to a site that had refused us. A 429, a 5xx and a
  network failure are retried once.
- **A refused address is logged, not surfaced.** Each refusal writes a WARN
  with the guard's reason. Recording it on the monitor as its own outcome is
  sub-phase 0.4's taxonomy (`BLOCKED`, added to the plan here), which needs a
  migration and the vendor page.
