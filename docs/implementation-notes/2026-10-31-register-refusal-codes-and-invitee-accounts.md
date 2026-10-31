# 2026-10-31 — Registration refusal codes and invitee accounts

**Commit:** `fix(auth): registration names its refusals, and an invitee registers without a workspace (#4686, #4689)`

## Design

`POST /api/auth/register` had two shapes of trouble.

1. **Every refusal was an English sentence with no code**, so the sign-in
   page showed English to a Bulgarian user. The route now answers
   `{ error, code }`, with `code` from `REGISTER_REFUSALS`
   (`src/lib/auth/register-refusals.ts`), the same shape change-password
   (#4645) and reset-password (#4688) use. The page labels a known code
   from `login.refused.*` and keeps the sentence only for one it does not
   name. The schema's `password: min(8)` became `min(1)`: the floor was
   answered by `withValidatedBody` as a bare `VALIDATION_ERROR`, before the
   route's own policy check could name it.

2. **Registering always created a workspace.** An invitee without Google
   or Microsoft could only get a password account by registering, which
   made them the Owner of a throwaway workspace before the sign-in
   redeemed their invitation. `orgName` is now optional:

   ```
   orgName present  → workspace + OWNER membership (unchanged)
   orgName absent   → inflect_invite_token cookie?
                        no               → WORKSPACE_NAME_REQUIRED
                        not live         → INVITE_UNAVAILABLE
                        other email      → INVITE_EMAIL_MISMATCH
                        same email, live → account only (no tenant, no membership)
   ```

   The sign-in that follows redeems the invitation exactly as it does for
   any other account: the cookie is read by the `signIn` callback, and
   `/invite/result` reports the outcome. The sign-in page asks for no
   organisation when `callbackUrl` is `/invite/result`, which is where
   "Sign in to accept" sends the browser.

Separately, `authorize()` in the Credentials provider now throws
`email_not_verified` for an unverified account instead of returning `null`,
so the page can say "confirm your email" rather than "invalid credentials".

## Files

| File | Role |
| --- | --- |
| `src/lib/auth/register-refusals.ts` | Client-safe codes, and the sign-in error name for an unverified email |
| `src/lib/auth/password-limits.ts` | Client-safe `MIN_PASSWORD_LENGTH` / `MAX_PASSWORD_LENGTH`, re-exported by `passwords.ts` |
| `src/app/api/auth/register/route.ts` | Codes on every refusal; the account-only path |
| `src/lib/schemas/index.ts` | `orgName` optional, password floor left to the route |
| `src/auth.ts` | `authorize()` names `email_not_verified` |
| `src/app/login/page.tsx` | Labels codes; invitee registration; `FormField` + `Input`; length limits only while registering |

## Decisions

- **Account-only registration needs a live invitation sent to that email.**
  An unnamed registration with no invitation would make an account that
  belongs nowhere and lands on "No access yet". Requiring the invitation
  keeps the route's footprint no wider than before: it still never makes an
  account that has nowhere to go.
- **The email is checked at registration, not left to redemption.**
  Redemption burns an invitation on an email mismatch (Epic 1), so letting
  the mismatch reach it would cost the invitee their link.
- **Naming `email_not_verified` leaks nothing.** `authenticateWithPassword`
  reports it only after the password matched, so it answers somebody who
  already holds the password. Every other failure stays `CredentialsSignin`.
- **The password field's length limits apply only while registering.**
  Sign-in does not re-check the policy, so an account whose password
  predates it can still get in; the old `minLength={6}` on the shared field
  was wrong in both modes.
- **The rate limit is unchanged.** `TENANT_CREATE_LIMIT` (5 an hour per IP)
  covers both shapes; an account-only registration is strictly less work.
