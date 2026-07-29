# 2026-07-29 — Automation security audit, part 2

**Commit:** `<sha>` fix(automation): webhook fail-closed, dry-run scrub, SLA poison pill, header lock, replay attribution

Second of two PRs. Part 1 (`2026-07-29-canvas-privilege-escalation.md`) carried
the CRITICAL; this one carries the remaining HIGH and the MEDIUMs.

## The audit was wrong in five places, and that shaped the work

Every finding was verified before implementation, and a second pass tried to
break each proposed fix. That caught more than it cost.

| Finding | What the reviewer got wrong |
|---|---|
| P1.4 | "unauthenticated" — the route is **not** in any `PUBLIC_PATH_PREFIXES` entry; middleware 401s anonymous callers. And "scope the connection lookup" is **not implementable**: the URL carries only `{provider}`. |
| P1.5 | Called it a privilege crossing. `canWrite` implies `canRead`, so every caller could already read those rows scrubbed. It is a bypass of the scrubber, not a boundary. |
| P1.6 | Three false premises, and the prescribed fix is a **regression**. See below. |
| P1.7 | The fix cannot live in Zod. And the `url` half is already backstopped at execution — `method` is the unguarded field. |
| P1.8 | Understated. The severe part — transaction poisoning — is not in the finding at all. |

## P1.6 — implemented the opposite of what was asked

The finding asked for a deterministic replay key. Implementing it would have
broken replay:

- **"unrate-limited" is false.** `withApiErrorHandling` applies
  `API_MUTATION_LIMIT` (60/min) to POST by default.
- **"CREATE_TASK without bound" is false.** On a manual replay `event.entityId`
  is the constant ruleId, so `auto:${ruleId}:${entityId}` collides on every
  replay after the first. The un-deduped actions are NOTIFY_USER and WEBHOOK —
  which the finding never mentions.
- **A deterministic key is harmful.** A rule-derived key makes replay
  one-shot-forever (the dispatcher swallows the duplicate while the route still
  answers 202); an execution-derived key changes every replay anyway. The
  randomness is what makes an intentional replay replay.

What *was* missing: **attribution**. `assertCanExecuteAutomation` is the
`canWrite` tier, so an EDITOR can replay a rule an ADMIN configured — firing
that ADMIN's webhook — while the execution row records only
`triggeredBy: 'manual'`, a literal with no actor. Nothing named who. That is the
sharper defect in a hash-chained GRC product, and it was free to fix.

## P1.8 — the severe part was not in the finding

`Notification.userId` is a real FK, and `sweepTenant` wraps the whole loop in
**one** transaction. So a single stale or foreign recipient id raised an FK
violation that rolled back **every** `recordCompletion` for that tenant — and
did so again every five minutes, forever. Not a tenant-isolation nit: a
permanent poison pill for the tenant's entire SLA sweep.

## P1.4 — the fix needed a blocker fixed first

`GitHubProvider.verifyWebhookSignature` hashed `JSON.stringify(payload.body)` —
a re-serialisation, not the signed bytes. `JSON.stringify(JSON.parse(raw))` is
not byte-identical to `raw` (key order, `1.0`→`1`, `\uXXXX`).

Today that only affects tenants *with* a secret. Post-fix those are the **only**
tenants who can succeed — so shipping fail-closed alone would have converted a
security fix into an outage. `WebhookPayload` now carries `rawBody`.

## Behaviour changes for existing tenants

Collected here because they belong at the top of a review, not buried:

1. **Webhook connections with no configured secret stop accepting deliveries.**
   That is the point — they were never authenticated — but it is live
   functional change.
2. **A webhook signature matching two connections is now refused** rather than
   silently routed to whichever the database returned first.
3. **Rule-supplied `Content-Type` / `User-Agent` / `X-Inflect-Signature` /
   `Authorization` headers are stripped.** Other custom headers still pass — a
   test pins that, because the fix must not become "no custom headers at all".
4. **`create` rejects a cross-tenant `nextRuleId`/`elseRuleId`** instead of
   persisting it.

## Deliberately not done

- **`secretRef`'s contract mismatch.** Documented as "never the raw secret",
  used directly as the HMAC key, so the raw value sits in plaintext
  `actionConfigJson` — not covered by the Epic B manifest. Honouring the
  contract needs a secret store that does not exist for automation rules;
  changing it needs a field rename plus a stored-config rewrite. Both carry
  migrations. What was fixed is the **dishonesty** — the type and the call site
  now say what actually happens.
- **Wiring the executor into the SLA breach path.** It needs a tenant execution
  context that path does not build. A loud warning beats a half-wired executor.
- **The pre-auth webhook dedupe.** Global, unscoped, and runs *before*
  verification — post-fix it is the cheapest remaining attack (replay a body so
  the genuine redelivery is dropped as a duplicate). Tracked separately; **not**
  claimed closed.

## Decisions

- **Four proposed changes were dropped after adversarial review**, each because
  it introduced a new problem: a `take: 200` cap that would permanently exclude
  the newest tenants; hoisting signature extraction above the DB (bypassed by
  one header); a failure-counting IP rate limit whose safety argument inverts
  once failures become common by construction; and payload truncation that
  doesn't achieve its goal since the body already hit disk.

- **A union return type can typecheck and still break at runtime.** Changing
  `decryptWebhookSecret` to a discriminated union left three call sites silently
  broken, because `{ state: 'absent' }` *is* structurally assignable to
  `Record<string, unknown>`. A test caught it; `tsc` could not. The explicit
  `secretsOf()` unwrap exists so the conversion is visible at every call site.

- **Two tests pinned the vulnerability and were inverted.** One was named
  "NO-SECRET branch ALLOWS the webhook to proceed (operator responsibility)".
  A test asserting the bug is not a reason to keep the bug.
