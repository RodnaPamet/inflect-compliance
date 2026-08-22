# 2026-08-22 — the fence that keeps `disconnectSharePoint` off identity connections

**Commit:** `(this branch) test(identity): fence the SharePoint disconnect away from identity connections`

## Design

#2089 made `ConnectedIdentityAccount.connectionId` required with
`onDelete: Cascade`. Deleting an `IntegrationConnection` therefore deletes the
roster that connection's sync observed. For the account rows themselves that is
the truthful outcome — the next sync rebuilds them. For four columns on those
rows it is not:

    isProtected · protectionReason · protectedAt · protectedByUserId

Those are operator-entered, they exist nowhere else in the product, and they are
**deliberately omitted from the sync upsert's `update` block** (stated twice, in
`personnel.prisma` and in `identity-sync.ts`, because it is the load-bearing line
of the break-glass rail). So a resync restores the account *without* its
protection. The next automatic leaver pass then offboards an account an operator
had marked never-offboard, and nothing in the system reads as broken.

**No path reaches that today, and that was verified rather than assumed:**

- `removeIntegrationConnection` — what the admin UI's DELETE calls — sets
  `isEnabled: false`. It does not delete a row.
- The only real row delete in the product is `disconnectSharePoint` in
  `src/app-layer/integrations/providers/sharepoint/service.ts`.
- A SharePoint connection can never hold identity accounts: `identity-sync.ts`
  is their sole creator and it gates on
  `{ okta, google-workspace, entra-id, active-directory }`.

A loaded gun with no trigger. The work is not to unload it — the cascade is
correct — but to fence the one trigger that exists.

**Scope, stated up front.** Every assertion goes through `disconnectSharePoint`,
so the suite detects exactly one regression: `loadConnection` losing its provider
filter. A SECOND `integrationConnection.delete(...)` call site added elsewhere
would leave the suite green. That gap is left open deliberately — closing it
needs an enumeration of delete call sites, i.e. a source scan, and a source scan
cannot answer whether a path is reachable. The broad claim ("the trigger cannot
appear silently") would have been the more comfortable sentence and the false
one.

## Where the safety property actually lives

**On the lookup, not on the delete.** `disconnectSharePoint` performs no provider
check of its own; it deletes whatever `loadConnection` hands back. It is safe
purely because `loadConnection` filters `provider: SHAREPOINT_PROVIDER` — one
clause in a private helper shared with the browse / client / allowed-sites /
disconnect paths. Widening that clause is an ordinary-looking edit, and none of
the *other* callers would visibly misbehave if it happened.

So the test drives the real function against a real identity connection, against
a real database, and asserts the row **survives**. It is the assertion that goes
red the day the provider filter comes off, and its failure message says so.

`tests/integration/identity-connection-delete-fence.test.ts`:

| assertion | what it is for |
| --- | --- |
| fixtures exist (superuser read, no tenant bound) | a "still there" claim is vacuous if the row was never written |
| `disconnectSharePoint(ctx, oktaConnId)` and `(…, entraConnId)` reject, rows survive, protection flags intact | **the fence** — the assertion the mutation proof turns red |
| `disconnectSharePoint(ctx, sharePointConnId)` resolves, row gone | positive control — without it the negative passes just as well when the function is broken outright |
| deleting an identity connection directly DOES take its protected account | the stake, stated as behaviour: if this stops being true (`onDelete` → `Restrict`/`SetNull`) the fence guards something different |

## Decisions

- **Integration test, not a source scan.** A grep for `provider:
  SHAREPOINT_PROVIDER` in `service.ts` would pass on a file where the filter had
  moved to a different query, and would fail on a harmless rename. The property
  is about what the database holds after the call, so the database is the
  instrument.
- **Not `tests/guards` / `tests/guardrails`.** The CI Ratchets job is DB-free by
  design; a DB-requiring ratchet there would demand a database from a job built
  not to have one.
- **Both identity providers, via `it.each`.** okta and entra-id both reach the
  file, so both are asserted. A fence proven for one provider is a fence someone
  can reasonably believe is provider-specific.
- **The banned assertion, and why.** "Deleting a SharePoint connection leaves
  `ConnectedIdentityAccount` untouched" was explicitly *not* written: SharePoint
  can never hold one, so it asserts an absence guaranteed by construction —
  green forever, testing nothing, and green in exactly the world where the fence
  has been removed.
- **Mutation proof.** Dropping `provider: SHAREPOINT_PROVIDER` from
  `loadConnection`'s where-clause turns both negative cases red
  (`Received promise resolved instead of rejected`) while the positive control
  and the cascade assertion stay green — i.e. the failure is specific to the
  fence, not to the function being broken. Restored from a `cp` backup
  (sha256-verified identical), re-run green.
