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
| **{{ui:auth.reset.tooShort}}** | The new password is shorter than 8 characters | Choose a longer one |
| A message that the link has expired, or is invalid or has already been used | The link is more than an hour old, has been used, or a newer one has been sent since | Ask for a new link on [{{ui:auth.forgot.resetTitle}}](forgot-password.md) and use the newest email |
| A message that the password appears in known data breaches | Attackers already know this password | Choose another |
| A message that the password is too long | The new password is longer than 128 characters | Choose a shorter one |
| **{{ui:auth.reset.couldNotReset}}** | The password was not changed, for another reason, for example after too many attempts | Wait a few minutes and try again |

The messages that come from the server, about the link and about the password, are in English, whatever language you use the app in.

## Related

- [{{ui:auth.forgot.resetTitle}}](forgot-password.md), to ask for a new link.
- [{{ui:login.signIn}}](sign-in.md), to sign in with your new password.
