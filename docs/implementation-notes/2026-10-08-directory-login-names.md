# 2026-10-08 — Persist directory login names (Step 0b)

**Commit:** `7199f1441d` — "Persist directory login names (Step 0b)" (#3273).
Change class: **Significant** (schema migration).

> **Written after the fact.** Reconstructed on 2026-10-16 from #3273's
> description, its diff and the phases document — not from doing the work. The
> step shipped without a note, which is part of what #3227 stayed open for.

## This is the end of a discard, not new collection

Active Directory's enumeration had requested `sAMAccountName` and
`userPrincipalName` since it shipped, and computed **both** on every account —
to derive `email`, then throw them away. Entra's `$select` already carried
`userPrincipalName` and did the same.

It matters because almost no on-premises application keys its users by email.
An AD-joined one stores `DOMAIN\sAMAccountName` or a bare `sAMAccountName`; an
Entra-federated one stores the UPN. The **directory bridge** is the only signal
that can produce a `LINKED` without a human confirming it — CLAUDE.md invariant
2 — and it has nothing to compare against unless these are stored. Without this
step every legacy row would arrive `SUGGESTED` at best.

| provider | `samAccountName` | `userPrincipalName` | `mailNickname` |
| --- | --- | --- | --- |
| Active Directory | yes | yes | — (no such attribute) |
| Microsoft Entra ID | — (not on the Graph user object) | yes | yes |
| Okta | — | — | — |
| Google Workspace | — | — | — |

Okta and Google Workspace leave all three unset **permanently**: their account
identifier *is* the email, which `email` already holds. Inventing a
`samAccountName` for them would manufacture a key the bridge could match on.

## `email` did not move, and that is the whole risk of this step

`email` is a **join key**. The JML link reconcile and the leaver pass compare it
byte for byte, so a provider that began preferring a UPN — a one-character
change to an `||` chain — would silently re-point live `IdentityAccountLink`
rows at a different worker, and the next leaver pass would **disable the wrong
person's account while reporting success**. Nothing would fail; the audit trail
would say it worked.

So each derivation is pinned against fixtures where **every candidate field
holds a different value**:

```
AD      email = upn || mail || sam     ada.upn@… / ada.mail@… / ada
Entra   email = mail || upn            grace.mail@… / grace.upn@… / ghopper
```

A fixture whose `mail` and `userPrincipalName` agree cannot tell a reordered
`||` from a correct one. That is the same discipline the repo applies elsewhere
under the heading "a fixture equal to the fallback proves nothing".

## Files

| File | Role |
| --- | --- |
| `prisma/schema/personnel.prisma` + migration | three nullable columns, additive, not backfilled |
| `providers/active-directory/index.ts` | stops discarding what it already computed |
| `providers/entra-id/index.ts` | same, plus `mailNickname` on the `$select` |
| `providers/identity/types.ts` | the three fields on the provider contract |
| `usecases/identity-sync.ts` | carries them to the write seam |
| `tests/unit/directory-login-names.test.ts` | 273 lines — the derivations and the per-provider table |
| `docs/data-retention.md` | the new columns recorded as PII |

Nine files, 553 insertions, three deletions — and the three deletions are the
point: this step removed the discards rather than adding collection.
