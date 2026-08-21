# 2026-08-21 — The guard that could not fire, and the redaction that would have looked done

**Commit:** `<pending>` fix(jml): make the self-lockout refusal able to fire, and keep directory identifiers out of logs

Two defects in code shipped the day before, found by surveying a task rather
than by a test. Neither could be caught by a test that already existed, and one
of them is a lesson about what a fix that "closes the gap" can still leave open.

## Design

### The self-lockout refusal was inert everywhere, not just in DRY_RUN

The filed defect (#138) was that `createSnapshotWriter` hardcoded
`selfAccountId: null` while its own comment claimed "the pass supplies it from
the connection instead". The pass did not, and `ResolveWriterInput` had no field
through which it could have. So in DRY_RUN — the only mode any tenant runs, for
a mandated seven days — the bind-account protection was a guard bound to
nothing.

Surveying it turned up the larger half (#146). The refusal was:

```ts
if (writer.selfAccountId && sameAccount(input.externalUserId, writer.selfAccountId))
```

and `sameAccount` is string equality. For Active Directory those two values come
from different namespaces: `externalUserId` is `formatObjectGuid(entry.objectGUID)`,
a **GUID**, while the bind is a **DN or userPrincipalName**. A GUID never equals
a DN, so the refusal could not fire in AUTOMATIC or PROPOSE either. The writer
already knows both shapes exist — `findAccount` dispatches on
`GUID_PATTERN.test(id)` to search by objectGUID or treat the id as a DN — but
the self-check did not use that knowledge.

Fixing only the plumbing would have produced a guard that was wired and still
could not fire, so both are closed together.

The contract becomes a list on both sides:

- **Writer side** — `selfAccountIds: readonly string[]`. Both binds, not just
  the one this writer authenticates with: a dedicated write bind does not make
  the read bind expendable, because the nightly sync authenticates as it, and
  disabling it stales every link and makes each later leaver pass refuse
  `NO_FRESH_LINKS`. Offboarding stops for everyone, and the account that stopped
  it looks like an ordinary leaver in the report.
- **Candidate side** — `DisableAccountInput.email`, which `findLeaverCandidates`
  gets one select-field away. The UPN is where the two namespaces actually meet.

No directory lookup is added. Resolving a bind to its objectGUID would need a
search per writer, and the dry run has no connection to search with. The
residual — a bind configured as a bare DN whose account carries no matching UPN
— is named in the code, and #137's operator flag is the general answer to it.

### Where the connection read moved, and where it did not

`resolveDirectoryWriter` returned the snapshot writer *before* reading any
connection. The read now happens first; the three refusal arms
(`NO_CONNECTION`, `AMBIGUOUS_CONNECTION`, `SECRETS_UNREADABLE`) deliberately did
not move with it.

The argument for withholding a live writer from a dry run was never about the
read — it is about the **constructor**. `createEntraIdWriter` refuses unless
`writesEnabled === true`, and requiring that flag in order to run the observation
rung would invert the ladder. The constructors are still below the arm, so
nothing is inverted. Promoting the refusals, on the other hand, would hand
DRY_RUN three new ways to produce nothing, and a tenant with two connections or
undecryptable secrets would stop observing during the seven days it is required
to observe. A dry run that cannot name the bind account is worse than one that
can, and far better than no dry run at all.

Secrets that will not decrypt therefore **degrade** the dry run rather than end
it: `bindDN` is a config field and needs no decryption, so one bind is still
protected, and the fallback logs a warning rather than silently yielding none.

### A redacted key is not a redacted line

The filed defect (#140) said `externalUserId` was missing from `REDACT_PATHS`.
Three corrections came out of the survey:

- `identity-disable-account.ts:351` is **not a log call** — it is the
  `externalUserId:` argument to `beginWrite()`, deliberate DSAR-declared
  persistence. Redacting it would defeat the reversibility record the whole rail
  exists to produce. Untouched.
- It is not a DRY_RUN issue: one of those sites fires in every mode.
- The blast radius is ten log sites, not four.

And the important one: **adding the key alone would have been the worst of the
available options.** Four of those sites also log `error: <provider message>`,
and the provider messages embed the identifier in their prose — "Entra refused
to disable account `<guid>`", "Refusing to disable `CN=…`". Pino does not reach
inside a string, so a key-only fix leaves the id in the field beside the redacted
one while making the line *look* sanitised. That is worse than the open gap,
because nobody reads a `[Redacted]` line twice.

So: the keys are redacted, the six usecase sites now name the opaque `linkId`
instead (it is in scope at all six; it is not in scope at the four writer sites,
which is exactly why the third piece is needed), and provider error text is
scrubbed at the log boundary.

The returned `reason` is deliberately **not** scrubbed. It reaches an operator
through a tenant-scoped, access-controlled surface where naming the account is
the entire use of it. A log line has neither property.

### The scrubber leaked a surname

Extracting the notification-side scrubber to a shared module and writing it a
test surfaced a bug in it. The DN pattern's value class excluded whitespace, so

```
CN=Alice Smith,OU=Staff,DC=corp,DC=example   ->   {account} Smith,{account}
```

The surname survived — in notification bodies as well as logs, which is most of
what the redaction existed for. A CN containing a space is the ordinary case,
not the exotic one. The value class now allows spaces, at the cost of absorbing
prose that immediately follows a DN with no comma between. That is the correct
direction for a scrubber to fail in, and the trade-off is pinned by a test so it
stays a decision rather than a surprise.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/identity-disable-account.ts` | `selfAccountIds` list contract; `matchesSelf` comparing every identity both sides can offer; `email` on the input and selected by `findLeaverCandidates`; log sites named by `linkId`; provider error text scrubbed |
| `src/app-layer/integrations/identity-writer-factory.ts` | connection read moved above the DRY_RUN arm, refusals left below; `selfAccountIdsFromConnection` degrading to config on a decrypt failure; `createSnapshotWriter` takes the ids |
| `src/app-layer/integrations/providers/active-directory/writer.ts` | names both binds, not just the effective one |
| `src/lib/security/redact-directory-identifiers.ts` | new — extracted from the notification path, DN pattern fixed |
| `src/app-layer/notifications/leaver.ts` | imports the shared scrubber |
| `src/lib/observability/logger.ts` | four directory-identifier keys added to `REDACT_PATHS`, with the reason a key alone is not enough |
| `docs/observability.md` | the redaction list corrected, and the "a redacted key is not a redacted line" rule written down |

## Decisions

- **Both defects in one change.** #138 alone ships a guard that is wired and
  still cannot fire — the exact failure class this round keeps finding, and not
  one worth reproducing while closing an instance of it.
- **A list, not a scalar, on both sides.** Two binds and several identifier
  forms are both genuinely plural. A scalar forced a choice — "the write bind is
  preferred" — that quietly left the read bind disposable.
- **Blank strings are dropped before comparing.** `'' === ''` would have made a
  writer with no configured bind refuse every candidate in a tenant whose
  accounts carry no mail.
- **Entra keeps an empty list.** An app registration is not a user. `null` was
  always the right answer there; only AD was ever protected by this rail.
- **`beginWrite`'s `externalUserId` stays.** The journal is the reversibility
  record; an opaque handle there would make a restore unactionable.
