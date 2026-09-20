# 2026-09-20 — the per-direction Entra writes flag (#2674, owner decision 8)

**Commit:** `<pending> feat(jml): split the Entra writes flag per direction`

## Design

Until now one per-connection boolean, `writesEnabled`, decided whether the Entra
writer could be constructed at all. With only a leaver that was enough. The
joiner makes it wrong, and not as a matter of tidiness:

```
WRITE_ROLES (entra-id/writer.ts) = [
    User.EnableDisableAccount.All      ← least privilege: disable only
    User.ReadWrite.All                 ← permits a CREATE, and a disable
    Directory.ReadWrite.All            ← permits a CREATE, and a disable
]
```

Creating a user requires one of the latter two, and both are already accepted
here — so **any consent sufficient to create is, by this repo's own list,
sufficient to disable**, and `hasWriteRole` stops objecting. A client-credentials
token asks for `.default`, which returns whatever an administrator already
consented rather than what we request, so there is no call-time scoping either.
The per-connection flag is the only layer left that can state the separation.

The shape:

```
write-direction.ts        ENTRA_WRITE_FLAG_FIELD = { leaver: 'writesEnabled',
                                                     joiner: 'joinerWritesEnabled' }
                          readDirectionWritesEnabled(config, direction)   strict === true
                          directionWriteRefusal(config, direction)        names the direction
                          isWritesNotEnabledRefusal(detail)               the factory's classifier

writer.ts (leaver)        directionWriteRefusal(config, 'leaver')   ← real call site today
DirectoryProvisioner      directionWriteRefusal(config, 'joiner')   ← the create verb's call site,
                                                                      which does not exist yet
```

`storedWriteFlag` is a `switch` over the direction with a `never` arm, not
`config[FIELD[direction]]`. A dynamic key is one typo — or one future direction
added to the record without a branch — away from reading the other direction's
flag, which is the single failure the module exists to prevent.

## Files

| file | role |
| --- | --- |
| `src/app-layer/integrations/providers/entra-id/write-direction.ts` | new — the two field names, the strict per-direction read, the refusal copy, the classifier phrase, `LEAST_PRIVILEGE_WRITE_ROLE` |
| `src/app-layer/integrations/providers/entra-id/writer.ts` | constructor gate now asks for `'leaver'` explicitly; `describeWritesEnabled` and `LEAST_PRIVILEGE_WRITE_ROLE` moved out; `WRITE_ROLES` untouched |
| `src/app-layer/integrations/identity-writer-factory.ts` | classifies `WRITES_NOT_ENABLED` through the imported predicate instead of its own inline regex |
| `tests/unit/entra-write-direction-split.test.ts` | the cross assertions, the legacy-config decision, the refusal copy, the pinned absence of the joiner field |
| `docs/jml-joiner-design.md` | consent-coupling section and open question 4 recorded as decided |

## Decisions

- **A pre-existing `writesEnabled: true` grants the LEAVER direction and
  nothing else.** The narrow reading, chosen deliberately. The box is labelled
  "Allow offboarding writes" and described as letting leaver offboarding
  *disable* accounts; reading it as covering creates would grant an authority
  its own copy never described. The error is also asymmetric — narrow costs one
  deliberate extra grant on the day the joiner ships, wide silently hands every
  existing writing tenant create authority with no diff on their side.

- **Neither direction is a superset of the other.** A joiner grant does not
  imply a leaver grant. Two statements about one credential, tested in both
  orders rather than one sample. The test's `DIRECTIONS` is a hand-written
  literal that happens to be the whole `IdentityDirection` union today; it does
  not track the union, and the comment there says so. A third direction is
  caught by `tsc` at `Record<IdentityDirection, string>` and the `never` arm of
  `storedWriteFlag`, not by that loop.

- **`joinerWritesEnabled` is deliberately NOT declared on the connection form.**
  Same argument `providers/hris/write-back.ts` makes for BambooHR: a checkbox is
  a question put to a customer. There is no create verb behind this direction —
  `JOINER_MAX_MODE` is `DRY_RUN`, nothing dispatches the planner, the live arm
  waits on #2608 — so a box ticked today would authorise nothing today and
  would *already be ticked* on the day it gains meaning. That is accidental
  consent read across time rather than across directions. The switch arrives in
  the diff that ships the write; the absence is pinned by a test so adding it is
  a reviewed diff.

- **The refusal names the direction, and the joiner arm says its switch does not
  exist rather than pointing at one.** An operator told to "turn on joiner
  writes" would otherwise go hunting for a control that is not on the form.

- **`WRITE_ROLES` is unchanged.** It states what Graph *accepts*; narrowing it
  would refuse tenants whose grant genuinely works. The separation is made where
  it can be made, and the credential-layer coupling is accepted and written
  down instead of being silently relied upon.

- **The factory's classifier is imported, not respelled.** `WRITES_NOT_ENABLED`
  used to be decided by an inline `/not enabled for directory writes/i` in
  `identity-writer-factory.ts` matched against a literal sentence in
  `writer.ts`. Adding the direction to that sentence is exactly the edit that
  breaks such a pair silently, and the symptom would have been a deliberate
  operator state arriving on screen as an unexplained `WRITER_REFUSED`.

- **The stored-value diagnostic is per-direction copy, not one sentence with
  the field name substituted.** `describeStoredWriteFlag` was parameterised by
  FIELD but carried leaver FACTS — that the flag "reads as ON in the admin UI",
  and that the fix is to re-save the connection. Neither is true of
  `joinerWritesEnabled`, which is deliberately undeclared: no control shows it,
  re-saving would not rewrite it, and `validateProviderConfig` rejects the key
  outright. The joiner sentence is unreachable today for two independent
  reasons (no caller passes `'joiner'`; the field cannot be stored), both
  asserted in the test rather than assumed — it was split now because the day
  the create verb lands is the day a wrong sentence reaches an operator.

- **The joiner arm has no production caller today, and that is stated rather
  than papered over.** Giving it one would have meant either inventing a live
  provisioner (blocked on #2608) or making a DRY_RUN plan refuse on a
  write-consent flag — which is the inversion `identity-writer-factory.ts`
  already argues against for the leaver: requiring standing write authority in
  order to *observe* what a write would do.
