# 2026-10-24 — "Enforce SSO" enforces

**Commit:** `fix(sso): "Enforce SSO" keeps every other way out of the workspace`

## Design

`TenantIdentityProvider.isEnforced` was written by the admin form and read by
nothing. Two helpers (`isLocalLoginAllowed`, `checkSsoEnforcementForEmail`)
described the intent and had no caller. So enforcing SSO changed nothing:
passwords, Google and Microsoft all kept working.

One rule now, in `src/lib/auth/sso-enforcement.ts`:

> A workspace that enforces SSO is reachable only by a session its own
> identity provider opened, or by a break-glass member: an OWNER or ADMIN who
> has a password and signed in with it.

It is applied where the earlier SSO scope is applied:

```
sign-in   signIn callback   no workspace left after enforcement → /login?error=sso_required:<slug>
claims    applyMembershipClaims  an enforced workspace the session isn't admitted to gets no claim → edge refuses
gates     getTenantCtx / getLegacyCtx / getTenantServerContext   assertSsoEnforcementAdmits → 403
```

The session records how it was opened (`signInMethod`: `credentials` /
`oauth` / `sso`), because break-glass is a password sign-in specifically.

## Files

| File | Role |
| --- | --- |
| `src/lib/auth/sso-enforcement.ts` | The rule, the break-glass roles, the enforced-workspace lookup, the gate assertion |
| `src/auth.ts` | `signInMethod` on the token; enforced workspaces filtered from the claims; sign-in refused when nothing is left |
| `src/app-layer/context.ts`, `src/lib/server/tenant-context.server.ts` | The DB-backed gates ask the rule |
| `src/app-layer/usecases/sso.ts` | Break-glass counts OWNER in the enforce toggle and the two existing helpers |
| `src/app/login/login-error.ts`, `page.tsx` | `sso_required:<slug>` opens the SSO form on that workspace |

## Decisions

- **Per workspace, not per person.** Someone in two workspaces, one
  enforcing, keeps a password session for the other. Refusing their sign-in
  outright would punish them for a policy only one workspace set. The sign-in
  is refused only when enforcement leaves them nothing, and then it names the
  workspace, so they reach its SSO rather than an empty "no workspace" page.
- **Google and Microsoft are refused too.** They are not the workspace's
  identity provider. Break-glass is for when that provider is down, and it
  means a local password.
- **Break-glass counts OWNER.** The enforce toggle refused to switch on
  unless an ADMIN had a password, so a workspace run by its OWNER could never
  enforce SSO. It also now counts only ACTIVE members.
- **A session minted before `signInMethod` existed reads as "not a password
  sign-in".** A break-glass member on an old session is refused an enforced
  workspace until they sign in again. That fails closed, and only for a
  policy that has never worked before.
- **The workspace rides inside the error code** (`sso_required:<slug>`).
  For a password sign-in, next-auth's client keeps only the `error` of the
  redirect it is handed, so a separate `sso=` parameter would be lost.
