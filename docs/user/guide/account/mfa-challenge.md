---
route: /t/[tenantSlug]/auth/mfa
---

# {{ui:mfa.verifyTitle}}

After you sign in with your password, a workspace that requires multi-factor authentication asks for the six-digit code from your authenticator app on this page. You reach the workspace only after entering it.

## Where to find it

You do not open this page yourself. You are sent here after signing in, before the workspace opens, when the workspace requires MFA. Each workspace that requires it asks for its own code.

## Who can use it

Everyone signing in to a workspace that requires MFA, whatever their role.

## What you see

**{{ui:mfa.verifyTitle}}**, the line **{{ui:mfa.verifyBody}}**, a box for the six-digit code and **{{ui:mfa.continueBtn}}**. Below it: {{ui:mfa.cantAccess}}

If you have not set up MFA for this workspace yet, the page shows **{{ui:mfa.enrollRequiredTitle}}** instead, with {{ui:mfa.enrollRequiredBody}}

## What you can do

### Enter your code

1. Open your authenticator app and find the entry for this workspace.
2. Type the six digits. **{{ui:mfa.continueBtn}}** turns on when all six are entered; pressing Enter works too.
3. The workspace opens at the page you were going to.

### Set up MFA first

When the page shows **{{ui:mfa.enrollRequiredTitle}}**, click **{{ui:mfa.setUpMfa}}**. The [{{ui:mfa.pageTitle}}](mfa.md) page walks you through it.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| {{ui:mfa.invalidCodeFormat}} | The code is not six digits | Enter the six digits from your app |
| {{ui:mfa.invalidCode}} | The code was wrong or had expired. Codes change every 30 seconds | Enter the code your app shows now |
| {{ui:mfa.tooManyAttempts}} | After five wrong codes in 15 minutes, codes are refused for five minutes | Wait five minutes, then try again |
| {{ui:mfa.verifyFailed}} | The code could not be checked | Try again |

If you have lost the phone with your authenticator app, ask an Owner or Admin of the workspace for help; you cannot sign in to it without a code while it requires one.

## Related

- [{{ui:mfa.pageTitle}}](mfa.md), where you set up or reset your authenticator.
- [Sign in](sign-in.md), the step before this one.
