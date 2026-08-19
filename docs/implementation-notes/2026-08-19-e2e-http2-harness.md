# 2026-08-19 — the E2E harness was the only tier speaking HTTP/1.1

**Commit:** `(this PR)` test(e2e): serve the harness over HTTP/2, like production

## The gap

| tier | protocol |
| --- | --- |
| production | `h1 h2 h3` — Caddy terminates TLS (`deploy/caddy/Caddyfile:18`) |
| E2E harness | **HTTP/1.1 only** — `next start` directly, no proxy |

Every other tier sits behind a proxy. The harness we gate merges on was the one
place serving raw HTTP/1.1 — so it validated behaviour under a transport the
product never uses.

## Why it mattered

HTTP/1.1 caps browsers at **six connections per origin**. The sidebar
deliberately forces a full-RSC prefetch of 14 `force-dynamic` routes
(`nav-item.tsx`), and opening the mobile drawer puts all 14 links in the
viewport at once. Through six sockets those queue,
`waitForLoadState('networkidle')` never settles, and every test that visits the
page burns its full 180 s timeout. Upstream describes the same mechanism:
[vercel/next.js#96109](https://github.com/vercel/next.js/issues/96109).

## What this does NOT fix — measured, not assumed

The task's acceptance test was: run `responsive.spec.ts` against **16.3.1**
with the `prefetch={false}` workaround **removed**. If the protocol were the
whole story, those tests would pass unaided.

**They did not.** 6 passed, 4 failed:

| test | HTTP/1.1 | HTTP/2 |
| --- | --- | --- |
| risks / policies / vendors / evidence | fail | **pass** (~4 s) |
| sidebar hidden · drawer · dashboard | fail | fail (3.0 m) |
| **desktop** sidebar visible | pass | **fail** (3.0 m) |

The desktop regression is the informative part. HTTP/2 removed the *connection*
limit but not the *work*: 14 full-RSC prefetches are 14 real server renders.
Over h1 they queued six at a time; over h2 they all fire at once. On desktop the
sidebar is visible, so all 14 links are in the viewport — and it got worse.

**So the cause is prefetch VOLUME, not transport.** The chain, corrected four
times: query-string prefetch (too narrow) → HTTP/1.1 pool exhaustion (a factor)
→ 14 concurrent `force-dynamic` renders (the load).

## What it does do

Closes a real fidelity gap, and is green on main's actual state — 16.2.12 with
the merged `prefetch={false}` — at **10/10 in 1.0 min**. It is shipped on that
basis alone, not as a fix for the hangs.

## Files

| File | Role |
| --- | --- |
| `scripts/e2e-http2-proxy.mjs` | h2 front door; generates a throwaway cert; proxies to `next start` |
| `playwright.config.ts` | `next start` → 3007, proxy → 3006, `baseURL` https, `ignoreHTTPSErrors` |
| `tests/e2e/global-setup.ts` | trusts the local cert for its pre-warm fetch |

## Decisions

- **Node, not Caddy.** Caddy is not on GitHub runners and would need a download
  step and a pinned version. `node:http2` is built in, so this behaves
  identically on a laptop and in CI with nothing to install.

- **The cert is generated at runtime, never committed.** A private key in the
  tree would trip `scripts/detect-secrets.sh`, correctly. It is regenerated
  into a gitignored cache dir on first run and is valid for localhost only.

- **`allowHTTP1: true`.** The goal is to make h2 *available*, matching
  production's `h1 h2 h3` — not to forbid h1.

- **`AUTH_URL`/`NEXTAUTH_URL` move to https.** NextAuth rewrites the request
  origin to `AUTH_URL` for every `/api/auth/*` request, so a scheme mismatch
  reintroduces the `MissingCSRF` / stuck-login class the existing comment in
  that file already warns about.

- **`global-setup` needed its own TLS opt-out.** It pre-warms with Node's
  `fetch`, which has its own trust store and does not read Playwright's
  `ignoreHTTPSErrors`. Without it every attempt failed with a bare
  `fetch failed` — and, worse, the suite then started against a cold server
  instead of erroring out. Found by running it, not by reading it.
