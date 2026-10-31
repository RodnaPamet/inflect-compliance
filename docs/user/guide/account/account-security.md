---
route: /account/security
---

# {{ui:account.security.securityTitle}}

The {{ui:account.security.securityTitle}} page is where you change the password you sign in with.

## Where to find it

Click your picture or initials at the top right of any page, then **{{ui:account.security.securityTitle}}**. The page has no menu of its own. **{{ui:account.backToWorkspaces}}**, at the top, takes you back: straight to your workspace if you have one, or to the list of your workspaces if you have several.

## Who can use it

Everyone who signs in with an email address and password, for their own account. If you sign in with Google, Microsoft or your organisation's single sign-on, you have no password here to change: the form is still shown, but it refuses the change.

## What it is for

Change your password when you think someone else may know it, or simply to replace a weak one.

## What you see

**{{ui:account.security.changePasswordTitle}}**, with three fields: **{{ui:account.security.currentPassword}}**, **{{ui:account.security.newPassword}}** and **{{ui:account.security.confirmPassword}}**, and the **{{ui:account.security.changePassword}}** button.

## What you can do

### Change your password

1. Type your current password.
2. Type the new one twice. It must be at least 8 characters, different from your current password, and must not be a password that has appeared in a known data breach.
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
| A message that your current password is incorrect | The current password you typed is wrong | Type it again. If you have forgotten it, sign out and use the forgotten-password link on the sign-in page |
| A message that the password appears in known data breaches | The new password is one attackers already know | Choose another |
| A message that the account signs in with a social provider and has no password | You sign in through Google, Microsoft or single sign-on | Nothing to change here |
| **{{ui:account.security.couldNotChange}}** | The password was not changed | Try again |

The messages from the server are in English, whatever language you use the app in.

## Related

- [{{ui:account.profile.profileTitle}}](profile.md), for your name and photo.
- [{{ui:mfa.pageTitle}}](mfa.md), to add a sign-in code to your password.
