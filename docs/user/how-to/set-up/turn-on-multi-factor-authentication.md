# Turn on multi-factor authentication

Multi-factor authentication (MFA) asks for a six-digit code from an authenticator app each time you sign in. Set it up for your own account, or, as an Owner or Admin, require it for everyone in the workspace.

## Set it up for your account

### Before you start

- Any role can do this: Owner, Admin, Editor, Reader, Auditor or AI admin.
- Install an authenticator app on your phone, such as Google Authenticator, Authy or 1Password.
- Check your workspace's MFA policy, which the page shows. Under DISABLED, nobody is asked for a code at sign-in, even with MFA set up.
- MFA is set up for one workspace at a time. If you belong to several workspaces, each has its own setup.

### Steps

1. Open the {{ui:mfa.pageTitle}} page:
    - If your workspace requires MFA, sign in. On the {{ui:mfa.enrollRequiredTitle}} screen, click **{{ui:mfa.setUpMfa}}**.
    - Otherwise, open the workspace you want to protect, click your picture or initials at the top right of the page, and click **{{ui:nav.multiFactorAuth}}**.
2. The {{ui:mfa.statusTitle}} card shows **{{ui:mfa.notEnrolled}}**. Under its title is the workspace's policy, in capitals: DISABLED, OPTIONAL or REQUIRED.
3. Click **{{ui:mfa.setUpMfa}}**. The {{ui:mfa.setUpAuthTitle}} panel opens.
4. In your authenticator app, add an account and scan the QR code on the page.
5. If you cannot scan it, choose to enter a key by hand in the app instead. Type the key shown under {{ui:mfa.setupKey}}, or click **{{ui:mfa.copy}}** and paste it. If the app asks for the type of key, choose time-based.
6. The app now shows a six-digit code that changes every 30 seconds. Type the current code into the box and click **{{ui:mfa.verifyEnable}}**.
7. The page shows **{{ui:mfa.enrolledSuccess}}** and the status changes to **{{ui:mfa.enrolled}}**.

The QR code and the key are shown only during setup, and you cannot view them again later. To stop halfway, click **{{ui:mfa.cancelEnrollment}}**.

## Require it for everyone in the workspace

### Before you start

- Only an Owner or an Admin can change the policy.
- Set up MFA for your own account first. The app refuses {{ui:admin.security.policy.REQUIRED.label}} until at least one active Owner or Admin has MFA set up.

### Steps

1. Click **{{ui:nav.admin}}**, the gear icon at the bottom of the sidebar.
2. Under {{ui:admin.section.security}}, click **{{ui:admin.nav.security}}**.
3. In the {{ui:admin.security.mfaPolicyTitle}} card, pick one of three options:
    - **{{ui:admin.security.policy.DISABLED.label}}**: nobody is asked for a code at sign-in, even members who set up MFA.
    - **{{ui:admin.security.policy.OPTIONAL.label}}**: each member decides. Members who set up MFA are asked for a code at every sign-in.
    - **{{ui:admin.security.policy.REQUIRED.label}}**: everyone is asked for a code at every sign-in. Members without MFA must set it up first.
4. To require it for everyone, pick **{{ui:admin.security.policy.REQUIRED.label}}**. A notice, {{ui:admin.security.beforeRequiredTitle}}, lists what to check first.
5. Click **{{ui:admin.security.saveSettings}}**, below the {{ui:admin.security.sessionSettingsTitle}} card. The page shows **{{ui:admin.security.settingsSaved}}**

## What happens next

- **After you set it up yourself.** Under {{ui:admin.security.policy.OPTIONAL.label}} or {{ui:admin.security.policy.REQUIRED.label}}, every sign-in now stops at {{ui:mfa.verifyTitle}}. Enter the current code from your app and click **{{ui:mfa.continueBtn}}**.
- If you set it up while already signed in, your current session carries on. The check starts at your next sign-in.
- If you set up MFA during a required sign-in, the app then asks for a code before you can open other pages.
- **After you require it.** The policy applies at each person's next sign-in. People already signed in keep working until they sign in again.
- At their next sign-in, members with MFA see {{ui:mfa.verifyTitle}} and enter a code.
- Members without MFA see {{ui:mfa.enrollRequiredTitle}}. They click **{{ui:mfa.setUpMfa}}** and follow the steps above. They cannot open any other page until they finish and enter a code.
- While the policy is {{ui:admin.security.policy.REQUIRED.label}}, nobody sees **{{ui:mfa.removeMfa}}**, so nobody can turn their own MFA off.
- To make everyone sign in again, click **{{ui:admin.security.revokeAll}}** on the same page and confirm the warning. This signs out every member, you included.

## If something goes wrong

| What you see | What it means | What to do |
| --- | --- | --- |
| An error instead of {{ui:admin.security.settingsSaved}} after you pick {{ui:admin.security.policy.REQUIRED.label}} | No active Owner or Admin in the workspace has MFA set up | Set up MFA for your own account, then save again |
| **MFA is already enrolled and verified. Remove existing enrollment first.** when you click **{{ui:mfa.setUpMfa}}** | You finished setting up MFA in another tab or window | Reload the page. The status shows **{{ui:mfa.enrolled}}** |
| An invalid-code message when you click **{{ui:mfa.verifyEnable}}** | The code did not match the key | Enter the newest code from your app. If it still fails, check the key, and check that your phone sets its time automatically |
| Codes are rejected after you started setup a second time | Each click on **{{ui:mfa.setUpMfa}}** makes a new key, so the old entry in your app no longer works | Delete the old entry from your app and add the new key |
| **{{ui:mfa.invalidCode}}** at sign-in | The code did not match | Enter the newest code. Codes change every 30 seconds, so check that your phone sets its time automatically |
| **{{ui:mfa.tooManyAttempts}}** | You entered five wrong codes in a row | Wait five minutes, then try again |
| The {{ui:mfa.pageTitle}} page shows **{{ui:mfa.notEnrolled}}**, but you set up MFA before | You set it up in another workspace. Each workspace has its own setup | Set it up in this workspace too |
| You are moving to a new phone | You cannot view the QR code or the key again, so you cannot copy them across | While you still have the old phone, sign in, click **{{ui:mfa.removeMfa}}** and confirm. Then set it up again on the new phone. Under {{ui:admin.security.policy.REQUIRED.label}} the button is hidden, so ask an Owner or Admin to switch the policy to {{ui:admin.security.policy.OPTIONAL.label}} while you move |
| You lost your authenticator app, and the sign-in page says **{{ui:mfa.cantAccess}}** | There are no backup codes, so you cannot pass the check on your own | Contact your workspace's Owner or Admin |
