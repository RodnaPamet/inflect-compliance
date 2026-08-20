# 2026-08-20 — the leaver rails, and the notification that finally reads them

**Commit:** `(this PR)` feat(jml): tell IT and the leaver's manager what the directory write did

## What this is

The last piece of the JML leaver path: the first consumer in the notification
subsystem that reacts to an identity event. It is a consumer and not new
plumbing — `IdentityWriteJournal` already holds every fact the message needs
(provider, action, mode, captured prior state, outcome, detail, the link the
write acted through), and `NotificationOutbox` already claims a row before
sending it.

Recorded alongside it are the four decisions the surrounding rails rest on,
because they are the ones a future engineer will be tempted to reverse.

## The inverted source of truth: HR proposes, the directory disposes

The obvious design has the HR feed as the authority: Workday says the worker is
terminated, therefore disable their accounts. That is exactly backwards for
every step after the first, and the codebase is built the other way round.

The HR feed **proposes**. It answers one question — *has this person left?* —
and it answers it about a `Employee` row, not about a directory account. Every
subsequent question is answered by the directory, or by something previously
observed in the directory:

| Question | Who answers | Where |
| --- | --- | --- |
| Has this worker left? | HR feed | `Employee.status` / the roster sync |
| Which account is theirs? | a pairing observed during a **healthy** sync | `IdentityAccountLink` |
| May a write land here at all? | the account's own observed `onPremisesSyncEnabled` | `identity-write-target` |
| Is the account already off? | a live read against the provider | `DirectoryWriter.readState` |
| Did the write happen? | the provider's acknowledgement, or nothing | `IdentityWriteJournal.outcome` |

Two consequences follow, and both are load-bearing.

**Absence of a link is a refusal, never a fallback.** The leaver path must not
match by email in the moment. Email is the one attribute that stops being
trustworthy exactly when it is relied on — the mailbox is converted to shared,
the address gains an `-ex` suffix or is released for reuse, the UPN changes, the
HR row is scrubbed for privacy. A missing link is a visible refusal somebody can
fix; a wrong link is a disable against the wrong person carrying an audit trail
that says the offboarding succeeded. Those failure modes are not symmetric, so
every ambiguity resolves toward the visible one.

**Configuration loses to observation, always.** Directory topology is not a
tenant setting and not an organization setting, because `onPremisesSyncEnabled`
is a per-USER flag: one Entra tenant holds both cloud-only and directory-synced
accounts, so "what is this tenant's topology?" has no correct answer. A
config-declared topology is a claim the config layer cannot verify; the observed
flag is what Azure AD Connect will actually honour.

## The match-key order

Exactly one key is live today, and the ordering is about what happens when it is
ambiguous rather than about trying a second key.

1. **Exact, case-normalised work email**, matching **exactly one** `Employee`.
   This is the only pairing a sync creates on its own, written as
   `IdentityLinkMethod.EMAIL_EXACT`. An email claimed by two employee rows maps
   to nothing — it is a data problem, and picking either row is a coin flip that
   later disables somebody.
2. **Already linked to the same worker** → the link is re-stamped
   (`lastVerifiedAt`), and any previous contradiction is cleared, because the
   evidence that disproved it has itself been superseded.
3. **Already linked to a DIFFERENT worker** → the link is *not* re-pointed, and
   is marked `contradictedAt`. Silently re-pointing would move a future disable
   from one person to another.
4. **No match at all, where a link exists** → also `contradictedAt`. An unlinked
   account matching nothing is just an unlinked account, usually a service
   account, and is only counted as `unmatched`.

`EXTERNAL_ID` and `MANUAL` exist in the enum and no code path writes them yet.
That is deliberate reservation, not an oversight: an HRIS external id is a
stronger key than email and will be preferred when a provider exposes one, and
the enum column is how that arrives without a migration.

At read time the leaver path adds two filters that are the whole point of the
model: `lastVerifiedAt >= staleBefore` and `contradictedAt IS NULL`. Freshness
alone was never a witness that a pairing is still true — only a bound on how long
ago it last was.

## The identifier rule

**No directory account identifier appears in any notification body.** Not
`externalUserId`, not UPN, not `sAMAccountName`, not a distinguished name, and
obviously no token. The bodies name the *worker* (HR-domain identity, already
known to both audiences) and the *provider*, and hand over an opaque journal
reference for everything else.

Three reasons, in order of weight:

- Half the recipients are **line managers**, who are frequently not tenant
  members and often have no login here at all. Email is the least-controlled
  surface this product writes to — forwarded, quoted into tickets, retained in
  mailboxes we do not administer.
- `sAMAccountName` and UPN **read as usernames**. A message pairing "this person
  has left" with a username is one plausible sentence away from a phishing
  template, arriving from a sender the recipient already trusts.
- Nothing is lost. The journal reference resolves to provider + account +
  captured prior state for anyone who can already read the journal — precisely
  the audience entitled to see it.

The same rule decides the links. The IT variant carries one link, to the synced
account roster at `/t/<slug>/admin/integrations/identity-accounts`, which exists.
The manager variant carries **none**: a manager with no membership follows an
admin link into a 403, which reads as a broken system at the worst possible
moment. And no message invents a reversal URL — there is no self-service restore
screen, so the mail states that plainly and hands over the reference instead of
producing a 404 for somebody mid-incident.

## Which outcomes notify

A disable has eight outcomes and they are not equivalent. The failure mode being
designed against is not a missed message; it is a channel that fires during
normal operation, gets filtered into a folder nobody opens, and takes the
`INDETERMINATE` message down with it.

| Outcome | IT | Manager | Why |
| --- | --- | --- | --- |
| `DISABLED` | ✅ | ✅ | It happened. One per departure, capped at 50 a run by the breaker. |
| `INDETERMINATE` | ✅ | ✅ | Nobody knows whether it happened. The one a human must act on — every other row in this table exists to keep this one readable. |
| `REFUSED_TARGET` | ✅ | ❌ | Account still live, but "Azure AD Connect masters this object" is not a sentence a manager can act on. |
| `REFUSED_PROTECTED` | ✅ | ❌ | Same shape — the account is live — but the refusal is permanent rather than a rung to climb, so silence would leave a real leaver enabled with nobody told. |
| `FAILED` | ✅ | ❌ | Provider **proved** it rejected the write. Telling the manager would assert a non-fact about a live account. Only ever written where that proof exists — an unclassified throw settles `INDETERMINATE`, because "the directory is unchanged" is a claim, not a default. |
| `REFUSED_MODE` | ❌ | ❌ | Normal for every tenant climbing the ladder — at least seven days by policy. Notifying means one mail per candidate per run for the whole evaluation period. |
| `DRY_RUN` | ❌ | ❌ | Nothing happened, by design. |
| `ALREADY_DISABLED` | ❌\* | ❌\* | Steady state. \*Unless the read **reconciled** an earlier unconfirmed write — then it answers a question a human was sent away to investigate, and goes out as a `DISABLED` mail flagged `RECONCILED`. |

`REFUSED_PROTECTED` arrived with the self-lockout refusal (#2036) after this
routing table was first written, and the table's own exhaustiveness is what
caught it: `planLeaverNotifications` has no `default` arm, so a new member of
`DisableOutcome` fails the build rather than falling through to silence. A
refusal that leaves the account live must never be the quiet one.

## The breaker values, and why two rules plus a floor

`identity-write-breaker` refuses a whole batch — never trims it to the cap.

- `MAX_DISABLES_PER_RUN = 50` — more than a plausible single-day offboarding wave
  at any tenant we serve, and far less than a directory.
- `MAX_DISABLE_SHARE = 0.1` — no run may exceed 10% of the known population.
- `SHARE_RULE_FLOOR = 5` — below this batch size the share rule does not apply.

Neither cap works alone. An absolute cap low enough to protect a 30-person tenant
blocks a 5,000-person tenant's normal Monday. A percentage low enough to be
meaningful at scale refuses every real event at the bottom end, where one
departure out of three is 33%. The floor is what stops the share rule from firing
on a tenant where one leaver is always a double-digit share — and a rail that
refuses correct input is a rail operators switch off.

**Refusing the whole batch is the point.** The cap is an anomaly detector, not a
rate limit: it fires when the batch is large enough that the likeliest
explanation is a broken feed. If the roster says 400 of 500 people left, the
correct response is "this feed is wrong", not "disable 20 and ask again
tomorrow". Trimming performs part of a probably-wrong action *and* hides the
anomaly behind a number that looks deliberate. A population of `0` is likewise
refused: an unknown denominator is not a safe one.

## Why reversibility landed before the write primitive

The order was breaker (#2017, 08-19) → journal (#2028, 08-20) → `disableAccount`
(#2030, 08-20). Reversibility shipped **first**, and shipped as an API shape
rather than a convention.

Disabling an account destroys the evidence of what it was. On-prem AD packs the
answer into one `userAccountControl` integer whose other bits —
password-never-expires, smartcard-required — are gone the moment it is
overwritten. "Undo the offboarding" is answerable only if the answer was written
down first, so `beginWrite` commits the journal row **before** the provider is
called and returns a handle whose only methods settle it. A caller cannot
perform a write without having captured, because the thing it needs in order to
report the outcome does not exist until the capture is committed. A convention
saying "remember to capture first" is one somebody eventually forgets on the
unhappy path — which is the only path where it matters.

Building it in the other order would have meant a working disable existing, for
some window, with no way back. There is no honest way to retrofit a capture:
by the time you add it, the writes already performed have destroyed the state
they would have captured.

The same ordering produced `PENDING` as a real answer. A crash between capture
and settle leaves a row that honestly means "the directory may or may not have
changed — go and look", and `listUnsettledWrites` makes those findable rather
than merely present. A design that recorded outcomes only afterwards would lose
exactly that case, and it is the one case a human must investigate. That row is
also why the notification exists at all, and why `INDETERMINATE` is the outcome
every silence rule above is protecting.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/notifications/leaver.ts` | Audience resolution + the outcome→recipient routing table. Never throws. |
| `src/app-layer/notifications/leaver-templates.ts` | The three bodies, in IT and manager variants. Carries the identifier rule. |
| `src/app-layer/notifications/enqueue.ts` | Three new arms in the type→builder switch. |
| `src/app-layer/notifications/index.ts` | Barrel exports. |
| `src/app-layer/usecases/identity-disable-account.ts` | Batch loop resolves the audience once, then notifies per result. |
| `prisma/schema/enums.prisma` | Three `EmailNotificationType` values. |
| `prisma/migrations/20260820100000_jml_leaver_notification_enum/` | `ALTER TYPE … ADD VALUE IF NOT EXISTS` ×3. |

## Decisions

- **Three enum values, not one with a variant field.** The outbox dedupe key is
  `(tenantId, type, toEmail, entityId, day)`. A single shared type would make the
  "we could not confirm it" mail and the later "we have now confirmed it" mail
  collide on the same journal row — and the resolution, the half a human is
  waiting on, is the one that would be dropped.
- **Dedupe entity is the journal id where one exists, the link id otherwise.** A
  journal row is created once, so `DISABLED` / `UNCONFIRMED` are exactly-once for
  all time. The pre-journal refusals fall back to the link id and therefore get
  per-day dedupe, which is the property that matters there: a daily pass over a
  hybrid-synced account would otherwise mail IT on every run forever.
- **A configured `complianceMailbox` does NOT replace the OWNER/ADMIN fan-out** —
  and the first draft of this module had it the other way round, on a rationale
  that inverts on inspection. `processOutbox` already sets that field as `bcc:`
  on *every* outbound message, and its only operator-facing label is "Compliance
  Mailbox (BCC)". Substituting it for the fan-out therefore mails the queue twice
  (To and Bcc) — the exact duplicate the substitution was avoiding — and tells no
  administrator at all, so a tenant that set up an archive would have silently
  opted out of every offboarding alert. The mailbox survives as the fallback for
  the one case the fan-out cannot cover: no privileged member holds an address,
  and a Bcc still needs a row to ride on.
- **`OWNER` as well as `ADMIN`, ordered.** `createTenantWithOwner` mints an OWNER
  and nothing else, so a role filter of `ADMIN` alone resolves zero recipients for
  the shape every tenant starts in. The query is ordered because `take` without
  `orderBy` lets the recipient set drift between passes once a tenant has more
  privileged members than the cap.
- **The manager is best-effort; IT is not.** `linkId` is nullable on the journal
  row, `managerEmployeeId` is nullable, and a manager row can carry no usable
  email. Each resolves to "no manager mail", never "no mail". Five additional
  suppressions are real HR-feed shapes: a self-managing employee, a manager whose
  work email *is* the leaver's, an unresolvable link, a manager who is themselves
  `TERMINATED` (their mailbox was disabled by an earlier pass), and a manager who
  is one of *this* batch's own leavers — a team wound down together offboards its
  lead in the same run. `OFFBOARDING` is deliberately still mailed: that is
  somebody working their notice, and still the right person to tell.
- **The audience is resolved once per batch, not per account.** Three queries for
  a 50-candidate run instead of 150, on the one code path already spending a
  customer's directory rate limit — and it keeps reads out of the disable loop.
- **Enqueue, never send.** A leaver pass must not inherit SMTP latency or SMTP
  failure. The outbox already claims a row before sending it.
- **Provider error text is redacted, sanitised and clamped.** Redaction is the
  half that was missing at first draft and matters most: Graph answers a stale
  link with `Resource 'dana@acme.test' does not exist` and LDAP with a whole DN,
  so passing the text through verbatim broke the identifier rule three sections
  up, in the one place where breaking it reaches a line manager's inbox. UPN, DN
  and GUID go by shape; the account's own `externalUserId` goes by exact match,
  which is the only way to catch a `sAMAccountName` — it has no shape to match.
  The order is sanitise-then-redact, against the usual rule, because the
  sanitiser DECODES entities: redacting first would inspect `dana&#64;acme.test`
  and hand the decoded address straight through. Safe in this direction only
  because redaction exclusively removes, substituting fixed literals that cannot
  carry markup back in.
- **Provider error text is sanitised and clamped to 300 characters.** It
  originates with a system we do not control and is persisted on the outbox row
  that a mail client, an operator surface, and any future SDK consumer read back
  verbatim — so it is sanitised at the write path, per Epic C.5, not at render
  time. An email is not a log.
