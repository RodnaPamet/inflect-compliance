---
route: /forgot-password
---

# {{ui:auth.forgot.resetTitle}}

The {{ui:auth.forgot.resetTitle}} page sends you an email with a link to choose a new password, for when you have forgotten the one you sign in with.

## Where to find it

On the sign-in page, click **{{ui:login.forgotPassword}}** under the password field. You do not need to be signed in.

## Who can use it

Anyone who signs in with an email address and password. If you sign in with Google, Microsoft or your organisation's single sign-on, your account has no password here, and no email is sent: sign in that way instead.

## What it is for

Get back into your account when you cannot remember your password. If you know your password and only want to change it, sign in and use [{{ui:account.security.securityTitle}}](account-security.md) instead.

## What you see

**{{ui:auth.forgot.resetTitle}}**, with: {{ui:auth.forgot.resetIntro}} Below it, **{{ui:auth.forgot.emailLabel}}**, the **{{ui:auth.forgot.sendResetLink}}** button, and **{{ui:auth.forgot.backToSignIn}}**.

## What you can do

### Ask for a reset link

1. Type the email address you sign in with.
2. Click **{{ui:auth.forgot.sendResetLink}}**.

The page then shows: {{ui:auth.forgot.resetSent}}

The page says this whether or not the address has an account, so it never reveals who has one. That also means it cannot tell you when you have typed the wrong address: if no email arrives, check the address and ask again.

## What happens next

- An email titled "Reset your password" arrives with a link. The link works once, for one hour. See [{{ui:auth.reset.chooseNewTitle}}](reset-password.md).
- Asking again sends a new link and cancels the earlier one, so use the newest email.
- Until you use the link, your password does not change. If you did not ask for the email, you can ignore it.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| No email arrives | The address has no account, the account signs in with Google, Microsoft or single sign-on, or the email went to your spam folder | Check your spam folder and the address you typed, or sign in the way you usually do |
| No email arrives after several requests | Each network can ask for at most five links an hour, and further requests send nothing although the page shows the same message | Wait an hour, then use the newest email |

## Related

- [{{ui:auth.reset.chooseNewTitle}}](reset-password.md), where the emailed link takes you.
- [{{ui:login.signIn}}](sign-in.md), to sign in once you have a new password.
