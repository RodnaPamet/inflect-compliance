# 2026-11-12 — Security test gaps: SSO single use, A2A token route, platform kill switch

**Issue:** #5376 (items 1, 2, 4 and 6 of the audit's list)

## Design

Tests first, on four pieces of security-relevant code that had none at the
level that matters. Two of them exposed defects, fixed here.

- **SSO hand-off and SAML flow spend** now run against Postgres. Single use
  rests on two database facts, a racing `deleteMany` counting the row for one
  caller only and the unique index on `VerificationToken.token`, and the
  in-memory double in the unit suite could not prove either. No defect.
- **A2A token route.** It read the body with `req.text()` and measured it
  afterwards. That gave the right 413 but buffered everything the caller sent
  first, so the 8 KiB cap did not bound memory. It now reads through
  `readA2aBody(req, MAX_BODY_BYTES)`, the reader both inbound routes use, which
  refuses on a declared `Content-Length` and again while it streams. Separately,
  a Basic header whose id or secret was not valid form-urlencoding (a stray `%`)
  made `decodeURIComponent` throw `URIError`, which escaped as a 500. The
  header now parses to `MALFORMED`, and the route answers
  `401 { "error": "invalid_client" }` before the usecase runs.
- **Platform kill switch.** `engagePlatformKill` read "nothing in force" and
  then inserted. Two engages racing past the read both inserted, the partial
  unique index `PlatformAgentKillSwitch_one_in_force` refused the loser, and its
  P2002 reached the route as a 500. That is the answer the route's header says
  an operator must never get. The loser now re-reads the winning row and
  returns it as `alreadyInForce: true` (200).
- **`readFanOutCap`.** Today's behaviour is pinned and not changed: a failed
  read gives the product default (3), which can be wider than a tenant's stored
  cap. Whether to fail to the default or fail narrow is an open owner question.

## Files

| File | Role |
| --- | --- |
| `src/app/api/a2a/[tenantSlug]/token/route.ts` | Body read through `readA2aBody` with the 8 KiB cap; an undecodable Basic header is a 401 `invalid_client` |
| `src/lib/agentic/kill-switch.ts` | `engagePlatformKill` turns the index's refusal of a racing engage into the idempotent answer |
| `tests/integration/sso-handoff-single-use.test.ts` | Hand-off and flow spend against Postgres: concurrent redemption, expiry, namespaces |
| `tests/unit/a2a-routes-body-cap-and-basic.test.ts` | The three A2A POST routes through the real `withApiErrorHandling`: bytes pulled before a 413, Basic parsing and precedence |
| `tests/integration/platform-kill-switch-route.test.ts` | Key gate (nothing written), GET, idempotent engage and lift, concurrent engages |
| `tests/unit/subagent-fanout-read-cap.test.ts` | Pins today's fail-to-default behaviour of `readFanOutCap` |

## Decisions

- **A malformed Basic header is refused even when the form body also carries
  credentials.** The body wins on precedence, so a strict reading would let
  the body through. But no client sends an undecodable Authorization header on
  purpose, and every such request was already a 500. Refusing it is no
  regression and avoids guessing which carriage the client meant.
- **The malformed-Basic 401 writes no audit row.** Like the 413, it is refused
  while the request is being parsed, before a tenant has been resolved. The
  usecase's `AUTHZ_DENIED` rows start once the request names a tenant and a
  grant.
- **The race fix catches P2002 and does not take a lock.** The unique index was
  already the authority, so the losing engage needs only the answer the read
  would have given it a millisecond later. If the re-read finds nothing (the
  winner was lifted in between), the original error is rethrown rather than
  reported as a stop that is not in force.
