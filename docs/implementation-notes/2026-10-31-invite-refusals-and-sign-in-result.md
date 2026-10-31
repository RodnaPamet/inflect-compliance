# 2026-10-31 — Invite refusals say why, and a sign-in says what became of the invite

**Commit:** `fix(invite): …` (#4689)

## Design

Two ways to accept a tenant invite, and both now tell the person the outcome
in their own language:

```
signed in as the invitee ── Accept ──► POST /api/invites/<token>
                                         └─ refusal: error.details.reason
                                            → invite.refused.<reason>

not signed in ── Sign in to accept ──► /api/invites/<token>/start-signin
   (cookie inflect_invite_token)          └─► /login?callbackUrl=/invite/result
                                               └─ signIn callback redeems the cookie
                                                  (a refusal is only logged)
                                          /invite/result ── inviteSignInOutcome()
                                               ACCEPTED → /t/<slug>/dashboard
                                               PENDING  → /invite/<token>
                                               REFUSED  → the reason, translated
```

`redeemInvite` names each refusal in `error.details.reason`
(`src/lib/invite-refusals.ts`). `inviteSignInOutcome` derives the same reasons
from the stored invite and the user's membership, because the sign-in callback
has no response to answer with: an email mismatch has already burnt the
invite by the time anyone could be told.

The invite page no longer reads its query string. It used to print `?error=`
verbatim, beside the workspace's name. The only writer of that parameter was
`GET /api/invites/<token>/accept-redirect`, which redeemed the invite on a
plain visit and which nothing linked to. That route is deleted.

## Files

| File | Role |
| --- | --- |
| `src/lib/invite-refusals.ts` | The reason codes and a parser for an API error body |
| `src/app-layer/usecases/tenant-invites.ts` | Refusals carry reasons; `inviteSignInOutcome` |
| `src/lib/errors/types.ts` | `notFound` / `gone` take optional `details`, as `forbidden` does |
| `src/app/invite/result/page.tsx` | Where "Sign in to accept" lands after sign-in |
| `src/app/api/invites/[token]/start-signin/route.ts` | Sends sign-in on to `/invite/result` |
| `src/app/invite/[token]/page.tsx`, `InviteAcceptButton.tsx` | No query-string text; translated refusals; Button primitives |

## Decisions

- **Derive the sign-in outcome; do not record it.** Setting a cookie from the
  NextAuth callback would carry the outcome directly, but the stored invite and
  membership already say what happened, and reading them needs no new state.
- **`/invite/result` names no token.** The token stays in the HttpOnly cookie,
  as `start-signin` intended. Only PENDING puts it back in a URL, the invite
  link the person came from.
- **The org invite page is unchanged.** Its redeemer is a POST from its own
  form, and it keeps its `?error=` surface. #4689 is about the tenant invite.
