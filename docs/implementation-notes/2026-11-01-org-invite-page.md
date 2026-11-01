# 2026-11-01 — Organization invitation page: refusals, accept, wrong account

**Issue:** #4853

## Design

The org invitation page now works the way the workspace invitation page has
since #4689:

```
signed in, matching email   → OrgInviteAcceptButton
                                POST /api/org/invite/<token>   (redeem, JSON)
                                refreshSessionClaims()         (re-mint the JWT)
                                router.push(/org/<slug>)
signed in, different email  → InviteSwitchAccountButton
                                signOut({ callbackUrl: /invite/org/<token> })
signed out                  → "Sign in to accept" → start-signin (unchanged)
```

`redeemOrgInvite` names each refusal in `details.reason` with the codes from
`src/lib/invite-refusals.ts`. The page maps them to `invite.orgRefused.*`. A
refusal that names no reason, such as a rate limit, falls back to the server
message, as the workspace button does.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/org-invites.ts` | Refusal reasons on every named redeem failure |
| `src/app/invite/org/[token]/page.tsx` | Reads no query string; uses the new controls and `AppIcon` |
| `src/app/invite/org/[token]/OrgInviteAcceptButton.tsx` | Client redeem + claims refresh + navigate |
| `src/app/invite/_components/InviteSwitchAccountButton.tsx` | Sign-out that returns to the invitation; used by both invite pages |
| `src/app/invite/[token]/page.tsx` | Wrong account gets the sign-out too |
| `src/app/api/org/invite/[token]/accept-redirect/` | Deleted |

## Decisions

- **`accept-redirect` is deleted, not repaired.** It redeemed on a plain GET as
  well as a POST, wrote `?error=<English message>` for the page to print, and
  answered a 303 into `/org/<slug>`. The edge org gate reads `orgMemberships`
  from the JWT with no DB hit, and that JWT predates the new membership, so
  the new member saw "Page not found" until the claims next refreshed. The
  JSON `POST /api/org/invite/<token>` already existed; the client button calls
  it and re-mints the claims before navigating.
- **Wrong account means sign out, never sign in.** "Sign in to accept" sends
  the person through start-signin. Signing in again with the same account
  redeems the cookie in the sign-in callback, and `redeemOrgInvite` claims the
  token before it checks the email, so the invitation is spent. The same holds
  for workspace invitations, which share the `wrongAccount` sentence, so both
  pages changed together.
- **A separate `orgRefused` catalogue.** The workspace sentences speak of
  "your admin" and, in one case, "the workspace". An organization invitation
  is sent by the organization's admin, so the codes are shared and the words
  are not.
- **The Accept button is paid for.** On the `Button` primitive it counts
  towards the primary ceiling, which main sits at. The policy page's
  per-version Publish, a row action in the version list, became secondary,
  following the precedent of its per-approval Approve (#4727).
