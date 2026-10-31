---
route: /login
---

# {{ui:login.signIn}}

The sign-in page is where you sign in to Inflect Compliance: with Google, with Microsoft, with your organisation's single sign-on, or with an email address and password. It is also where you create a new organisation of your own.

## Where to find it

Open the app's address in your browser. Whenever you are signed out, any page of the app sends you here first, and a link from an email does the same.

## Who can use it

Everyone with an account, and anyone who wants to create a new organisation.

Which ways of signing in you see depends on how your organisation runs the app. **{{ui:login.continueWithGoogle}}**, **{{ui:login.continueWithMicrosoft}}** and **{{ui:login.sso.continue}}** are always shown. The email and password form, and **{{ui:login.registerLink}}**, can be switched off, in which case they are not on the page at all.

## What it is for

Sign in the way your workspace expects. If your workspace requires single sign-on, it is the only way in: the page tells you so and opens the single sign-on form for you.

## What you see

**{{ui:login.signIn}}**, with three buttons:

- **{{ui:login.continueWithGoogle}}**
- **{{ui:login.continueWithMicrosoft}}**
- **{{ui:login.sso.continue}}**

Below them, where the email form is offered: **{{ui:login.orContinueWithEmail}}**, then **{{ui:login.email}}** and **{{ui:login.password}}**, **{{ui:login.forgotPassword}}**, and the **{{ui:login.submitLogin}}** button. Under the form, **{{ui:login.noAccount}}** **{{ui:login.registerLink}}**, and a box to request a new verification email.

A notice above the buttons explains what has just happened, for example **{{ui:login.resetSuccess}}** after you reset your password, or **{{ui:login.passwordChanged}}** after you change it.

## What you can do

### Sign in with Google or Microsoft

Click **{{ui:login.continueWithGoogle}}** or **{{ui:login.continueWithMicrosoft}}** and sign in on that provider's page. You come back here signed in.

### Sign in with single sign-on

1. Click **{{ui:login.sso.continue}}**.
2. Under **{{ui:login.sso.workspaceLabel}}**, type your workspace's short name: {{ui:login.sso.workspaceHint}}
3. Click **{{ui:login.sso.submit}}**.

You are sent to your organisation's sign-in page. If the workspace offers more than one way to sign in, you choose one first.

The page asks for your workspace rather than your email address on purpose. Any workspace's administrator can type in an email domain, and nobody checks it belongs to them, so the domain cannot be trusted to pick your organisation.

### Sign in with your email and password

Type your email address and password, and click **{{ui:login.submitLogin}}**.

If you have forgotten your password, click **{{ui:login.forgotPassword}}**. See [{{ui:auth.forgot.resetTitle}}](forgot-password.md).

### Create an organisation

1. Click **{{ui:login.registerLink}}**. The heading changes to **{{ui:login.register}}**.
2. Fill in **{{ui:login.name}}**, **{{ui:login.orgName}}**, **{{ui:login.email}}** and **{{ui:login.password}}**. The password must be 8 to 128 characters and must not be one that has appeared in a known data breach.
3. Click **{{ui:login.submitRegister}}**.

A new workspace is created for your organisation, you are its Owner, and you are signed in to it. **{{ui:login.signInLink}}** switches back to signing in.

### Create an account to accept an invitation

If a colleague invited you and you do not sign in with Google or Microsoft, you need a password account first.

1. On the invitation page, click **{{ui:invite.signInToAccept}}**.
2. On the sign-in page, click **{{ui:login.registerLink}}**. The heading changes to **{{ui:login.registerAccount}}**, and the page says: {{ui:login.inviteAccountOnly}}
3. Fill in **{{ui:login.name}}**, the email address the invitation was sent to, and a **{{ui:login.password}}**, then click **{{ui:login.submitRegister}}**.

You are signed in, and the invitation is accepted. No workspace of your own is created. See [{{ui:invite.invitedTitle}}](accept-an-invite.md).

### Request a new verification email

Type your email address in the box at the bottom and click **{{ui:login.resend}}**. The page answers **{{ui:login.resendSent}}**, whether or not the address has an account, so the page never reveals who has one.

## What happens next

- You go to the page you were trying to open, if you were sent here from one, for example by a link in an email.
- Otherwise, with one workspace you go straight to its dashboard. With several, you choose one: see [Choose a workspace](workspaces.md).
- If your workspace requires a code from an authenticator app, you are asked for it next.
- If your workspace requires single sign-on and you signed in another way, you come back here with **{{ui:login.errors.ssoRequired}}** and the single sign-on form open.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:login.invalidCredentials}}** | The email address or password is wrong. Each wrong attempt makes the next one slower, and after ten in a row the account is locked for 15 minutes, showing this same message even for the right password | Check both and try again, wait 15 minutes, or use **{{ui:login.forgotPassword}}** |
| **{{ui:login.errors.ssoRequired}}** | Your workspace only accepts single sign-on | Type your workspace's short name in the form that opens, and continue |
| **{{ui:login.errors.accountNotLinked}}** | Your email address already has an account that signs in a different way, for example with Google rather than Microsoft | Sign in the way you did before |
| **{{ui:login.sso.notAvailable}}** | The workspace you typed does not use single sign-on, or there is no workspace by that name | Check the short name, or sign in another way |
| **{{ui:login.sso.failed}}** | The page could not check the workspace | Try again |
| **{{ui:login.errors.ssoNoAccount}}** | Single sign-on worked, but the workspace has no account for you | Ask the workspace's administrator to add you |
| **{{ui:login.errors.ssoDomainNotAllowed}}** | Your email address is not one the workspace's single sign-on accepts | Ask the workspace's administrator |
| **{{ui:login.errors.ssoUnavailable}}** | The workspace's single sign-on is switched off or set up wrongly | Ask the workspace's administrator |
| **{{ui:login.errors.ssoIncomplete}}** | Single sign-on started but did not finish | Try again, or ask the workspace's administrator |
| **{{ui:login.errors.ssoStartFromSignIn}}** | Single sign-on was started from somewhere other than this page | Start it again from **{{ui:login.sso.continue}}** |
| **{{ui:login.errors.signInFailed}}** | Sign-in failed for another reason | Try again |
| {{ui:login.emailNotVerified}} | Your password is right, but you have not confirmed your email address yet | Open the link in the verification email, or request a new one in the box at the bottom |
| **{{ui:login.linkExpired}}** or **{{ui:login.linkInvalid}}** | The email verification link you followed cannot be used | Request a new one in the box at the bottom |
| {{ui:login.refused.EMAIL_ALREADY_REGISTERED}} | You already have an account | Sign in, or use **{{ui:login.forgotPassword}}** |
| {{ui:login.refused.PASSWORD_TOO_SHORT}}, {{ui:login.refused.PASSWORD_TOO_LONG}} or {{ui:login.refused.PASSWORD_BREACHED}} | The password does not meet the rules | Choose another password |
| {{ui:login.refused.INVITE_EMAIL_MISMATCH}} | You are creating an account to accept an invitation, with a different email address from the one invited | Use the invited address |
| {{ui:login.refused.INVITE_UNAVAILABLE}} | The invitation you are creating an account for has expired, was withdrawn, or was already used | Ask for a new invitation |
| {{ui:login.tooManyRegistrations}} | Too many accounts were created from your network in the last hour | Wait an hour, then try again |
| **{{ui:login.registrationFailed}}** | The account was not created, for another reason | Try again |

## Related

- [{{ui:auth.forgot.resetTitle}}](forgot-password.md), if you have forgotten your password.
- [Choose a workspace](workspaces.md), where you go after signing in if you belong to several workspaces.
- [{{ui:invite.invitedTitle}}](accept-an-invite.md), if a colleague has invited you.
- [{{ui:mfa.pageTitle}}](mfa.md), to protect your sign-in with a code.
