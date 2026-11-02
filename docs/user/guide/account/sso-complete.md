---
route: /login/sso-complete
---

# Finishing single sign-on

After your identity provider confirms who you are, this page finishes signing you in and then takes you on. It shows **{{ui:login.ssoComplete.title}}** with the line **{{ui:login.ssoComplete.inProgress}}** for a moment, and moves on by itself.

## Where to find it

You do not open this page yourself. Your workspace's identity provider sends you here after you sign in with single sign-on, from the [sign-in page](sign-in.md) or a workspace's sign-in link.

## Who can use it

Anyone signing in with single sign-on. The sign-in is good only for the workspace whose identity provider you used.

## What you see

While it works, **{{ui:login.ssoComplete.inProgress}}**. When it is done, you go to the page you were on your way to, or to your workspaces.

## What you can do

Nothing, unless it fails. Then the page says **{{ui:login.errors.ssoIncomplete}}** and offers **{{ui:login.ssoComplete.backToSignIn}}**.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| {{ui:login.errors.ssoIncomplete}} | The sign-in could not be finished. The hand-over from the identity provider lasts one minute and works once, so going back, reloading, or a slow network can each end it | Click **{{ui:login.ssoComplete.backToSignIn}}** and start single sign-on again. If it keeps failing, ask your workspace administrator |

## Related

- [Sign in](sign-in.md), where single sign-on starts.
- [Single sign-on](../admin/sso.md), how an administrator sets it up.
