# 2026-08-27 — Telling an observed cloud-only account from an unknown one

**Commit:** `(PR #2144)` fix(identity): tell an OBSERVED cloud-only account apart from an unknown one

## Design

The leaver path was **permanently inert for cloud-only Entra directories**, and
it took the first real tenant to find out. All 10 accounts synced with
`onPremisesSyncEnabled = NULL` from a fully-consented enumeration that reached
`PASSED`; the write-target rail refused every candidate as "never observed" while
advising the operator to run a sync they had already run.

Microsoft's contract is `true` when the object is synced from an on-premises AD
and, verbatim, *"otherwise the user isn't being synced and can be managed in
Microsoft Entra ID"*. A null is that "otherwise" — the ordinary, permanent state
of every user in a tenant without AD Connect.

**The rail was not wrong to be careful; it was handed a value that could not
carry the difference.** `ConnectedIdentityAccount.onPremisesSyncEnabled` is
nullable *precisely* because, in its own schema comment, "we do not know" and
"cloud-only" are different answers — and the connector collapsed both into null
with `?? null`.

So the fix preserves the distinction rather than widening the rail:

```
Graph answers  →  connector records WHETHER it answered  →  column  →  rail
   null                onPremStateObserved: true            stamp     allow
   absent              onPremStateObserved: false            null     refuse
   true                          —                            —       refuse + retarget
```

`onPremStateObservedAt` is a timestamp written as a **pair** with the value from
the same pass, and cleared when a provider does not answer, so a stale stamp can
never sit beside a fresh unknown.

## Files

| File | Role |
| --- | --- |
| `prisma/schema/personnel.prisma` + migration | the column; nullable, no default, no backfill |
| `providers/identity/types.ts` | `onPremStateObserved` on the normalised account |
| `providers/entra-id/index.ts` | derives it from the response, never hardcoded |
| `providers/entra-id/writer.ts` | same distinction on the live re-read; capture schema → v2 |
| `identity-writer-factory.ts` | snapshot capture kept at parity with the live one |
| `usecases/identity-sync.ts` | writes the pair on both upsert arms |
| `usecases/identity-disable-account.ts` | selects, maps via `Boolean(...)`, threads to the rail |
| `usecases/identity-write-target.ts` | the rail, gated on `NULL_MEANS_NOT_SYNCED` |
| `lib/observability/integration-metrics.ts` | REFUSED_TARGET now documents both meanings |

## Decisions

- **No backfill.** Existing rows keep refusing until a sync observes them. Stamping
  rows this migration never watched would assert an observation nobody made — the
  exact confusion the column exists to end. Cost: one re-sync. The alternative
  cost is a wrongly-enabled write path.

- **The allow is gated on a provider set, not on the flag alone.** Okta and Google
  Workspace hardcode null because they have no on-premises concept; a provider
  author could reasonably set "we asked" without their null meaning "not synced".
  The flag says we asked; `NULL_MEANS_NOT_SYNCED` says the answer means what the
  branch's quoted contract says it means.

- **`Boolean(...)`, not `!== null`.** The strict form reads `undefined` — an
  unselected column, an older row shape — as *observed*, failing OPEN on a rail
  whose job is to fail closed.

- **Capture schema bumped to v2.** The journal capture gained a key; leaving the
  stamp at v1 would make an absent key mean both "that era did not record it" and
  "Graph did not answer", which is the ambiguity the stamp exists to prevent.
  Journal rows are immutable, so this is cheap now and unrecoverable later.

- **Two adversarial review passes, five findings.** The first found the change
  *net-harmful*: the live writer still refused what the rail newly allowed, and
  because DRY_RUN uses the snapshot writer — which never reaches that check — the
  dry run would have reported "would disable" for exactly the accounts the live
  path cannot disable. A seven-day observation window that disagrees with the
  live path is worse than one that refuses.

## Known gaps, filed rather than fixed

- The stamp's **age** is never checked; the consumer reduces a `DateTime` to a
  boolean. The apparent backstop (`lastVerifiedAt`, 48h) is provider-scoped while
  the sync that writes the stamp is connection-scoped.
- The pass's decision record **cannot distinguish** a decision made under the
  widened rule from one made under the old one, which is information the
  seven-day window's reader wants.
