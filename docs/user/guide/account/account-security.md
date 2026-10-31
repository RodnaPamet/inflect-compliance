---
route: /account/security
---

# {{ui:account.security.securityTitle}}

The {{ui:account.security.securityTitle}} page is where you change the password you sign in with.

## Where to find it

Click your picture or initials at the top right of any page, then **{{ui:account.security.securityTitle}}**. The page has no menu of its own; use your browser's back button to return to where you were.

## Who can use it

Everyone who signs in with an email address and password, for their own account. If you sign in with Google, Microsoft or your organisation's single sign-on, you have no password here to change, and the page says so instead of showing the form.

## What it is for

Change your password when you think someone else may know it, or simply to replace a weak one.

## What you see

**{{ui:account.security.changePasswordTitle}}**, with three fields: **{{ui:account.security.currentPassword}}**, **{{ui:account.security.newPassword}}** and **{{ui:account.security.confirmPassword}}**, and the **{{ui:account.security.changePassword}}** button.

If your account has no password, the card instead says: {{ui:account.security.passwordlessNotice}}

## What you can do

### Change your password

1. Type your current password.
2. Type the new one twice. It must be 8 to 128 characters, different from your current password, and must not be a password that has appeared in a known data breach.
3. Click **{{ui:account.security.changePassword}}**.

The message **{{ui:account.security.passwordChangedRedirect}}** confirms it, and you are taken to the sign-in page.

## What happens next

- You are signed out everywhere: in this browser, on your other devices, and in every workspace. Sign in again with the new password.
- Anyone else who was signed in as you is signed out too, which is why changing your password is the first step if you think your account was used by someone else.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:account.security.fillAllThree}}** | A field is empty | Fill in all three |
| **{{ui:account.security.newPasswordsNoMatch}}** | The two new passwords differ | Type the same new password in both |
| **{{ui:account.security.tooShort}}** | The new password is too short | Use at least 8 characters |
| **{{ui:account.security.mustDiffer}}** | The new password is the same as the current one | Choose a different one |
| **{{ui:account.security.tooLong}}** | The new password is too long | Use at most 128 characters |
| **{{ui:account.security.currentIncorrect}}** | The current password you typed is wrong | Type it again. If you have forgotten it, sign out and use the forgotten-password link on the sign-in page |
| **{{ui:account.security.breached}}** | The new password is one attackers already know | Choose another |
| **{{ui:account.security.withoutPassword}}** | You sign in through Google, Microsoft or single sign-on | Nothing to change here |
| **{{ui:account.security.couldNotChange}}**, or another reason the server gave | The password was not changed | Follow the reason given, or try again |

## Related

- [{{ui:account.profile.profileTitle}}](profile.md), for your name and photo.
- [{{ui:mfa.pageTitle}}](mfa.md), to add a sign-in code to your password.
