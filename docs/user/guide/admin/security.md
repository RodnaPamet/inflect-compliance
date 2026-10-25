---
route: /t/[tenantSlug]/admin/security
---

# {{ui:admin.security.title}}

The {{ui:admin.security.title}} page holds the workspace's sign-in rules: whether members must use multi-factor authentication (MFA), and how long a sign-in may last. It also holds two rules for agents that use API keys, and it revokes sessions.

## Where to find it

Click **{{ui:nav.admin}}**, the gear icon at the bottom of the sidebar. On the {{ui:admin.title}} page, under {{ui:admin.section.security}}, click **{{ui:admin.nav.security}}**. The breadcrumb reads **{{ui:admin.crumb.dashboard}}** › **{{ui:admin.crumb.admin}}** › **{{ui:admin.security.crumbSelf}}**.

This page sets the rules for everyone. To set up MFA for your own account, click your picture or initials at the top right of the page, then **{{ui:nav.multiFactorAuth}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page | Owner, Admin |
| Change the MFA policy and the session age | Owner, Admin |
| Turn agent registration enforcement on or off | Owner, Admin |
| Change the API-key rotation age | Owner, Admin |
| Revoke your own sessions, one member's, or everyone's | Owner, Admin |

Editors, Readers, Auditors and AI admins see **{{ui:admin.forbidden.title}}** instead of the page. If your workspace uses custom roles, what you can do depends on the permissions your role was given. The **{{ui:admin.security.agentEnforcement.title}}** card also needs permission to read the workspace's agent register. Without it, the card shows a note in place of its button.

## What it is for

Use it to decide how members prove who they are at sign-in, and to end sessions after a security incident. If agents act in your workspace through API keys, use it as well to decide whether only registered agents may act, and when an old agent key gets flagged.

## What you see

The page is a column of cards. From top to bottom:

**{{ui:admin.security.mfaPolicyTitle}}.** Three options. The one in force is highlighted.

| Option | What it does |
| --- | --- |
| {{ui:admin.security.policy.DISABLED.label}} | Nobody is asked for a code at sign-in, even members who set up MFA. Members can still set it up, and existing setups are kept |
| {{ui:admin.security.policy.OPTIONAL.label}} | Each member decides. Members who set up MFA are asked for a code at every sign-in |
| {{ui:admin.security.policy.REQUIRED.label}}, marked {{ui:admin.security.strictBadge}} | Everyone is asked for a code at every sign-in. Members who have not set up MFA must do so before they can open any page |

A workspace that has never chosen a policy is at {{ui:admin.security.policy.DISABLED.label}}.

Picking {{ui:admin.security.policy.REQUIRED.label}} shows a notice, **{{ui:admin.security.beforeRequiredTitle}}**, with three points to check before you save. Single sign-on gives nobody a way round a required code: a sign-in through single sign-on is asked for one, just like a password sign-in.

**{{ui:admin.security.sessionSettingsTitle}}.** One field, **{{ui:admin.security.maxSessionAgeLabel}}**. It sets the longest a sign-in may last, counted from the moment the person signs in. It takes 5 minutes to 30 days, which is 43,200 minutes. Left empty, the product's default applies.

**{{ui:admin.security.saveSettings}}** sits below these two cards and saves both of them, and nothing else. The cards below it have buttons of their own.

**{{ui:admin.security.agentEnforcement.title}}.** Whether Inflect's agent tools accept only API keys that are bound to a registered agent. A badge reads {{ui:admin.security.agentEnforcement.on}} or {{ui:admin.security.agentEnforcement.off}}, and a sentence below it says what that means today. When some active API keys are bound to no agent, a list names each one, with the first characters of the key. The button reads **{{ui:admin.security.agentEnforcement.enableAction}}** or **{{ui:admin.security.agentEnforcement.disableAction}}**. A new workspace starts with enforcement on.

**{{ui:admin.security.apiKeyRotation.title}}.** The age at which the daily key check raises a finding for an API key an agent could use. A badge shows where the age comes from: {{ui:admin.security.apiKeyRotation.defaultBadge}}, which is 90 days, or {{ui:admin.security.apiKeyRotation.customBadge}}. Below it you choose between the product default and **{{ui:admin.security.apiKeyRotation.useCustom}}**. The second choice opens a field for a whole number of days, from 7 to 730, with buttons to step it down and up.

**{{ui:admin.security.sessionMgmtTitle}}.** Two buttons, **{{ui:admin.security.signOutOthers}}** and **{{ui:admin.security.revokeAll}}**. Below them, under {{ui:admin.security.revokeSpecificLabel}}, a **{{ui:admin.security.userIdPlaceholder}}** field and a **{{ui:admin.security.revoke}}** button.

## What you can do

### Set the MFA policy

Pick an option and click **{{ui:admin.security.saveSettings}}**. The message **{{ui:admin.security.settingsSaved}}** shows for a few seconds.

Set up MFA for your own account before you pick {{ui:admin.security.policy.REQUIRED.label}}. The page refuses to save {{ui:admin.security.policy.REQUIRED.label}} until at least one active Owner or Admin has set up MFA in this workspace. [Turn on multi-factor authentication](../../how-to/set-up/turn-on-multi-factor-authentication.md) walks through both steps.

### Set a session age

Type a number of minutes in **{{ui:admin.security.maxSessionAgeLabel}}** and click **{{ui:admin.security.saveSettings}}**. To go back to the default, empty the field and save. A new age is set on sign-ins that start after you save. Sign-ins already under way keep the end time they started with.

### Enforce agent registration

Read the list on the card first. Once enforcement is on, Inflect's agent tools accept only API keys bound to an active registered agent, so they refuse every key on the list. An API key cannot be edited. To keep a listed integration working, create a new key bound to its agent and revoke the old key. [Create an API key](../../how-to/set-up/create-an-api-key.md) shows how.

Then click **{{ui:admin.security.agentEnforcement.enableAction}}**. The dialog **{{ui:admin.security.agentEnforcement.enableTitle}}** shows the list again and asks you to type the workspace's short name, the part of its address after `/t/`. The button in the dialog works only once the name matches exactly. To back out, click **{{ui:common.cancel}}**. The change applies to the whole workspace at once.

**{{ui:admin.security.agentEnforcement.disableAction}}** works the same way, in the dialog **{{ui:admin.security.agentEnforcement.disableTitle}}**. It asks for the name too, because switching enforcement off changes nothing you can see. Afterwards, an API key no longer needs a registered agent to use the agent tools.

### Set the API-key rotation age

Choose the product default, or **{{ui:admin.security.apiKeyRotation.useCustom}}** and a number of days. Click **{{ui:admin.security.apiKeyRotation.save}}**, which stays greyed out until you change something. The message **{{ui:admin.security.apiKeyRotation.saved}}** appears.

The age only decides when a finding is raised. No key is ever rotated, revoked or expired because of it. [Create an API key](../../how-to/set-up/create-an-api-key.md) lists which keys the daily check looks at, and what else it flags.

### Revoke sessions

Each of these asks you to confirm in a browser dialog first.

- **{{ui:admin.security.signOutOthers}}** revokes all of your own sessions, on every device. Despite its name, that includes the browser you are using. The page then takes you to the sign-in page.
- **{{ui:admin.security.revokeAll}}** revokes the sessions of every member of the workspace, you included. Keep it for a security incident. The page then says how many members it covered.
- To revoke one person's sessions, type their user ID in the **{{ui:admin.security.userIdPlaceholder}}** field and click **{{ui:admin.security.revoke}}**. This page cannot look the ID up for you. When you know who it is but not their ID, use the {{ui:admin.members.colSessions}} column on the **{{ui:admin.nav.members}}** page instead, which revokes a member's sessions one device at a time.

A session belongs to the person, not to the workspace. Revoking someone's sessions here also revokes the ones they use for other workspaces.

## What happens next

- **A new MFA policy applies at each person's next sign-in.** People already signed in carry on until they sign in again. [Turn on multi-factor authentication](../../how-to/set-up/turn-on-multi-factor-authentication.md) describes what members see.
- **Each workspace's MFA policy applies to that workspace.** Someone who belongs to more than one workspace is asked at sign-in for the code of the first workspace they joined. Another workspace whose policy asks for a code asks for its own the first time they open it, and until they enter it, its pages and the organisation pages take them to its code page. The session age is always that of the first workspace they joined, except after a sign-in through this workspace's single sign-on, which gets this workspace's.
- **Agent registration enforcement applies at once.** Each request it refuses adds an entry to the workspace's audit log.
- **The rotation age applies from the next daily key check.**
- **The audit log records who did what.** Turning agent registration enforcement on or off, changing the rotation age and every revocation of sessions each add an entry to the workspace's **{{ui:admin.auditLog}}**, naming who did it.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:admin.security.loadingTitle}}**, with grey bars | The page is loading the settings | Wait a moment |
| **{{ui:admin.security.failedLoadSettings}}** | The page could not reach Inflect to load the settings | Reload the page |
| {{ui:admin.security.policy.DISABLED.label}} selected and the session age empty, although you know they were set | The page could not load the saved settings. It shows the defaults instead of an error | Reload the page. Do not save first: saving stores what the page shows |
| **Cannot enable REQUIRED MFA: at least one active owner or admin must be enrolled in MFA first. Please set up MFA for your account before enabling this policy.** | No active Owner or Admin has set up MFA in this workspace | Set up MFA for your own account, then save again |
| **Session max age must be at least 5 minutes** or **Session max age cannot exceed 30 days** | The session age is outside the range the field takes | Enter 5 to 43,200 minutes, or leave the field empty |
| **{{ui:admin.security.failedSave}}** | The save did not go through, and the reason was not given | Reload the page and try again |
| The {{ui:admin.security.agentEnforcement.title}} card says you do not have permission to read the agent register | Your role cannot read the agent register, or the card could not load | Reload the page. If the note stays, ask an Owner |
| **{{ui:admin.security.apiKeyRotation.unavailable}}** | The card could not load the rotation age | Reload the page. If the note stays, ask an Owner |
| The button in the agent registration dialog stays greyed out | What you typed does not match the workspace's short name exactly | Type the name exactly as the field's label shows it |
| **Invalid cuid** after you click **{{ui:admin.security.revoke}}** | What you typed is not a user ID | Check the ID, or use the {{ui:admin.nav.members}} page |
| **Target user is not a member of this tenant** | No member of this workspace has that ID | Check the ID |
| **{{ui:admin.security.failedRevokeSessions}}** | Your own sessions could not be revoked | Try again |
| **{{ui:admin.security.failedRevoke}}** or **{{ui:admin.security.failedRevokeUser}}** | The revocation did not go through, and the reason was not given | Reload the page and try again |

## Related

- [Turn on multi-factor authentication](../../how-to/set-up/turn-on-multi-factor-authentication.md) covers setting up MFA for yourself and requiring it for everyone, and what to do when a code is refused.
- [Create an API key](../../how-to/set-up/create-an-api-key.md) explains agent bindings and the daily key check.
- [{{ui:admin.sso.title}}](sso.md) connects the workspace to your identity provider. Its sign-ins follow the MFA policy set here.
