---
route: /t/[tenantSlug]/security/mfa
---

# {{ui:mfa.pageTitle}}

The {{ui:mfa.pageTitle}} page is where you set up a second step for signing in to a workspace: a six-digit code from an authenticator app on your phone, asked for after your password. Multi-factor authentication is set up for one workspace at a time.

## Where to find it

Open the workspace you want to protect, click your picture or initials at the top right of the page, and click **{{ui:nav.multiFactorAuth}}**. If the workspace requires MFA and you have not set it up, you are sent here when you sign in.

## Who can use it

Everyone, for their own sign-in: Owner, Admin, Editor, Reader, Auditor and AI admin. Requiring MFA for everyone is an Owner's or Admin's choice on the workspace's security settings; see [{{ui:admin.security.title}}](../admin/security.md).

## What it is for

A password alone can be guessed, reused or stolen. With MFA, someone who has your password still cannot sign in without your phone.

## What you see

**{{ui:mfa.statusTitle}}.** The card shows the workspace's policy after **{{ui:mfa.tenantPolicy}}**:

| Policy | Meaning |
| --- | --- |
| {{ui:admin.security.policy.DISABLED.label}} | Nobody is asked for a code at sign-in, even with MFA set up |
| {{ui:admin.security.policy.OPTIONAL.label}} | You are asked for a code if you have set MFA up |
| {{ui:admin.security.policy.REQUIRED.label}} | Everyone must set MFA up, and is asked for a code at every sign-in |

Beside it, whether you are **{{ui:mfa.enrolled}}** or **{{ui:mfa.notEnrolled}}**, and when enrolled, since when. When the workspace requires MFA and you have not set it up, the card also says **{{ui:mfa.orgRequires}}**

Under it, **{{ui:mfa.setUpMfa}}** when you are not enrolled, or **{{ui:mfa.removeMfa}}** when you are and the workspace does not require MFA.

## What you can do

### Set up MFA

Click **{{ui:mfa.setUpMfa}}**. The **{{ui:mfa.setUpAuthTitle}}** panel shows a QR code and a **{{ui:mfa.setupKey}}**. Scan the code with your authenticator app, or type the key into it, then type the six-digit code the app shows and click **{{ui:mfa.verifyEnable}}**. The message **{{ui:mfa.enrolledSuccess}}** confirms it. Step-by-step instructions are in [Turn on multi-factor authentication](../../how-to/set-up/turn-on-multi-factor-authentication.md).

The QR code and key are shown only while you set up. **{{ui:mfa.cancelEnrollment}}** stops without enabling anything.

### Remove MFA

Click **{{ui:mfa.removeMfa}}** and confirm **{{ui:mfa.removeConfirmTitle}}** The message **{{ui:mfa.removedSuccess}}** confirms it. You can set it up again at any time. You cannot remove MFA in the middle of signing in, before you have entered your code.

## What happens next

- From your next sign-in to this workspace, you are asked for a code after your password, unless the policy is {{ui:admin.security.policy.DISABLED.label}}.
- Starting the set-up, finishing it and removing MFA are each recorded in the workspace's audit log, naming whose authenticator it was. A removal by an Owner or Admin for somebody else is recorded as such.
- If you lose your phone, ask an Owner or Admin of the workspace for help; you cannot sign in to it without a code while the policy asks for one.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:mfa.loadingTitle}}** | The page is loading | Wait a moment |
| **{{ui:mfa.loadFailed}}** | Your MFA status did not load | Reload the page |
| **{{ui:mfa.invalidCodeFormat}}** | The code is not six digits | Type the six digits the app shows |
| **{{ui:mfa.invalidCodeRetry}}**, or the reason the server gave | The code was wrong or has expired | Type the code that shows now; codes change every 30 seconds |
| **{{ui:mfa.startFailed}}** | Setup could not start | Try again |
| **{{ui:mfa.removeFailed}}**, or the reason the server gave | MFA was not removed | Follow the reason given |

## Related

- [Turn on multi-factor authentication](../../how-to/set-up/turn-on-multi-factor-authentication.md), the step-by-step version, including how to require it for the workspace.
- [{{ui:account.security.securityTitle}}](account-security.md), to change your password.
