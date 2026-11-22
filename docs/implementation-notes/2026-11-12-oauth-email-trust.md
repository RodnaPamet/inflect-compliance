# 2026-11-12 — OAuth email trust and claiming unverified accounts

## Design

`src/lib/auth/oauth-email-trust.ts` answers two questions for the `signIn`
callback in `src/auth.ts`:

1. **Does the provider vouch for the email?** Google: `email_verified === true`.
   Microsoft: the optional `xms_edov` claim is true. Any other provider: no.
   Only a vouched email links an OAuth sign-in to an existing account or
   redeems a pending invite by address. An unvouched sign-in to an address an
   account already holds is sent back to `/login?error=OAuthAccountNotLinked`.
   The emailed invite link (token-bound) is unchanged.
2. **What happens to an account whose email was never verified?** A vouched
   sign-in claims it when it carries a competing credential: password removed,
   other provider links removed, sessions revoked (`UserSession` rows and a
   `sessionVersion` bump), outstanding reset links spent, `emailVerified`
   stamped, audited `AUTH_UNVERIFIED_ACCOUNT_CLAIMED`. Without a competing
   credential the account is only stamped.

## Files

| File | Role |
| --- | --- |
| `src/lib/auth/oauth-email-trust.ts` | The vouching rule and the claim |
| `src/auth.ts` | `signIn` gates linking, claiming and invite-by-address on it |
| `src/lib/auth/security-events.ts` | `AUTH_UNVERIFIED_ACCOUNT_CLAIMED` audit event |

## Decisions

- **Microsoft trusts `xms_edov` only** (owner decision). It must be added as an
  optional claim on the app registration; until then Microsoft sign-ins do not
  link to existing accounts by email.
- **A verified sign-in takes over** rather than being refused (owner decision):
  the person who proved the address is the one left holding a way in.
- **Only competing credentials trigger a claim.** OAuth-created users are stored
  with no `emailVerified`, so claiming on that alone would revoke every OAuth
  user's sessions on their first sign-in after deploy.
- **MFA enrolments are kept.** Removing them would weaken a legitimate owner's
  account; a squatter with no password and no provider link cannot use them.
