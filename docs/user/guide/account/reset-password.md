---
route: /reset-password
---

# {{ui:auth.reset.chooseNewTitle}}

The {{ui:auth.reset.chooseNewTitle}} page is where you set a new password, after following the link in a password reset email.

## Where to find it

Click the link in the "Reset your password" email. You get that email by asking for it on [{{ui:auth.forgot.resetTitle}}](forgot-password.md). You do not need to be signed in.

## Who can use it

Whoever holds a reset link that is still valid. A link works once, for one hour, and only the newest link sent to an account works.

## What it is for

Choose a new password when you have forgotten the old one.

## What you see

**{{ui:auth.reset.chooseNewTitle}}**, with **{{ui:auth.reset.newPasswordLabel}}**, **{{ui:auth.reset.confirmLabel}}**, the **{{ui:auth.reset.resetPassword}}** button, and **{{ui:auth.reset.backToSignIn}}**.

If you open the page without a link from an email, it shows **{{ui:auth.reset.invalidLink}}** and **{{ui:auth.reset.requestNewLink}}** instead of the form.

## What you can do

### Choose a new password

1. Type your new password in **{{ui:auth.reset.newPasswordLabel}}**. It must be 8 to 128 characters and must not be one that has appeared in a known data breach.
2. Type it again in **{{ui:auth.reset.confirmLabel}}**.
3. Click **{{ui:auth.reset.resetPassword}}**.

## What happens next

- You are taken to the sign-in page, which says **{{ui:login.resetSuccess}}**. Sign in with the new password.
- You are signed out everywhere else: every device where you were signed in has to sign in again.
- The link is used up. To change your password again later, sign in and use [{{ui:account.security.securityTitle}}](account-security.md).

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:auth.reset.invalidLink}}** | The page was opened without a reset link | Click **{{ui:auth.reset.requestNewLink}}** and ask for one |
| **{{ui:auth.reset.fillBoth}}** | One of the fields is empty | Fill in both |
| **{{ui:auth.reset.passwordsNoMatch}}** | The two passwords differ | Type the same password in both |
| **{{ui:auth.reset.tooShort}}** or **{{ui:auth.reset.tooLong}}** | The new password is shorter than 8 or longer than 128 characters | Choose another |
| **{{ui:auth.reset.refused.RESET_LINK_EXPIRED}}** | The link is more than an hour old | Click **{{ui:auth.reset.requestNewLink}}** and use the newest email |
| **{{ui:auth.reset.refused.RESET_LINK_INVALID}}** | The link has been used, or a newer one has been sent since | Click **{{ui:auth.reset.requestNewLink}}** and use the newest email |
| **{{ui:auth.reset.refused.PASSWORD_BREACHED}}** | Attackers already know this password | Choose another |
| **{{ui:auth.reset.tooManyAttempts}}** | Too many attempts were made from your network | Wait 15 minutes, then try again |
| **{{ui:auth.reset.couldNotReset}}** | The password was not changed, for another reason | Try again |

## Related

- [{{ui:auth.forgot.resetTitle}}](forgot-password.md), to ask for a new link.
- [{{ui:login.signIn}}](sign-in.md), to sign in with your new password.
