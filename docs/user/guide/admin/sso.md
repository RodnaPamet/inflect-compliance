---
route: /t/[tenantSlug]/admin/sso
---

# {{ui:admin.sso.title}}

The {{ui:admin.sso.title}} page connects the workspace to your company's identity provider, over OIDC or SAML 2.0, so that members sign in with their company account. It can also make single sign-on the only way into the workspace.

## Where to find it

Click **{{ui:nav.admin}}**, the gear icon at the bottom of the sidebar. On the {{ui:admin.title}} page, under {{ui:admin.section.identity}}, click **{{ui:admin.nav.sso}}**. The breadcrumb reads **{{ui:admin.crumb.dashboard}}** › **{{ui:admin.crumb.admin}}** › **{{ui:admin.sso.crumbSelf}}**.

The {{ui:admin.nav.scim}}, {{ui:admin.nav.entra}} and {{ui:admin.nav.integrations}} pages carry a row of links to each other and to this page, which the row calls **{{ui:admin.identityNav.sso}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page and see the saved configurations | Owner, Admin |
| Set up a configuration, or change which identity provider it trusts | Owner |
| Rename a configuration, change its other settings, test it and delete it | Owner, Admin |
| Make single sign-on the only way in | Owner, Admin, once at least one active Owner or Admin of the workspace has an Inflect password |

Editors, Readers, Auditors and AI admins see **{{ui:admin.forbidden.title}}** instead of the page. If your workspace uses custom roles, what you can do depends on the permissions your role was given. A role that opens the admin pages but does not manage the workspace sees a note saying that only an Owner or an Admin can see and change single sign-on, and no settings.

## What it is for

Use it when your company wants people to sign in to Inflect with the account they already use at work. The page holds the values your identity provider and Inflect need to trust each other. Once single sign-on works, you can make it the only way into the workspace.

Single sign-on never creates accounts and never adds anyone to the workspace. Each person must already be a member, under the email address the identity provider sends.

## What you see

**The protocol switch.** **OIDC** and **SAML 2.0**, at the top of the page, choose which configuration the page shows. The workspace keeps one configuration of each. Switching to the other protocol discards anything you typed and did not save.

**The badge** on the right shows the state of the configuration you are looking at:

| Badge | What it means |
| --- | --- |
| {{ui:admin.sso.notConfigured}} | Nothing is saved for this protocol |
| {{ui:admin.sso.disabled}} | A configuration is saved, but **{{ui:admin.sso.enableSso}}** is unticked, so nobody can sign in with it. This is the badge even when **{{ui:admin.sso.enforceSso}}** is saved ticked, because enforcement applies only while the configuration is enabled |
| {{ui:admin.sso.enabled}} | Members can sign in with it |
| {{ui:admin.sso.enforced}} | Members can sign in with it, and it is the only way into the workspace: **{{ui:admin.sso.enableSso}}** and **{{ui:admin.sso.enforceSso}}** are both saved ticked |

**The configuration card**, headed **OIDC Configuration** or **SAML Configuration**. Two fields are the same for both protocols:

| Field | What it holds |
| --- | --- |
| {{ui:admin.sso.providerName}} | A name for the configuration. Members see it only when both an OIDC and a SAML configuration are enabled, to choose between them. Left empty, it is saved as OIDC Provider or SAML Provider |
| {{ui:admin.sso.emailDomains}} | Optional. The email domains allowed to sign in this way, separated by commas, such as `acme.com, acme.io`. Left empty, any address may sign in |

For OIDC, the card also asks for the {{ui:admin.sso.issuerUrl}}, the {{ui:admin.sso.clientId}}, the {{ui:admin.sso.clientSecret}} and the {{ui:admin.sso.scopes}}, which start as `openid email profile`. The eye button beside the secret shows what you type. The page does not show the redirect URI your identity provider needs. [Set up single sign-on](../../how-to/set-up/set-up-single-sign-on.md) gives it.

For SAML, it asks for the {{ui:admin.sso.entityId}}, the {{ui:admin.sso.ssoUrl}}, the {{ui:admin.sso.certificate}} and the {{ui:admin.sso.nameIdFormat}}. The help icon beside the last one says when to fill it in. **{{ui:admin.sso.acsUrl}}** cannot be edited: it is the address to give your identity provider.

**Fields only an Owner can change.** The {{ui:admin.sso.issuerUrl}} and {{ui:admin.sso.clientId}}, the {{ui:admin.sso.entityId}}, {{ui:admin.sso.ssoUrl}} and {{ui:admin.sso.certificate}}, and the {{ui:admin.sso.emailDomains}} decide which identity provider the workspace trusts, and so who can sign in as which member. An Admin sees them greyed out, with a note saying so. With nothing set up yet, an Admin's **{{ui:admin.sso.saveConfig}}** is greyed out too.

**Saved secrets.** Once a configuration is saved, its {{ui:admin.sso.clientSecret}} or {{ui:admin.sso.certificate}} shows as dots. The stored value never comes back to your browser, not even with the eye button. Leave the dots as they are to keep it, or type over them to replace it.

**The switches.** **{{ui:admin.sso.enableSso}}** lets members sign in with the configuration. **{{ui:admin.sso.enforceSso}}**, marked {{ui:admin.sso.enforceHint}}, makes single sign-on the only way into the workspace. Ticking it shows a notice about the one exception, break-glass access, described below.

**The buttons.**

- **{{ui:admin.sso.saveConfig}}** saves the card and both switches.
- **{{ui:admin.sso.testLogin}}** appears once the saved configuration is enabled.
- **{{ui:admin.sso.delete}}** appears once a configuration is saved.

**{{ui:admin.sso.howTitle}}.** A box at the foot of the page sums up the rules.

## What you can do

### Connect your identity provider

This takes the Owner role. Choose **OIDC** or **SAML 2.0** and fill in the card with the values from your identity provider. Tick **{{ui:admin.sso.enableSso}}** and click **{{ui:admin.sso.saveConfig}}**. The message **{{ui:admin.sso.savedOk}}** appears, and the badge reads {{ui:admin.sso.enabled}}.

OIDC needs the issuer URL, the client ID and the client secret. SAML needs the entity ID, the SSO URL and the certificate. Inflect does not read a SAML metadata file, so each value is typed in. [Set up single sign-on](../../how-to/set-up/set-up-single-sign-on.md) says what goes where, on this page and in your identity provider.

### Test a sign-in

Click **{{ui:admin.sso.testLogin}}**. Your identity provider's sign-in opens in a new tab. Sign in there with your own company account.

- If the tab comes back to this page, the test passed, and your account is now linked to the identity provider.
- If it shows the Inflect sign-in page with a message, the test failed. [Set up single sign-on](../../how-to/set-up/set-up-single-sign-on.md) explains each message.

A test that passes signs your browser in through single sign-on, for this workspace only. To open your other workspaces again, sign out and sign in the way you usually do.

### Make single sign-on the only way in

Test first. Then tick **{{ui:admin.sso.enforceSso}}** and click **{{ui:admin.sso.saveConfig}}**. The badge reads {{ui:admin.sso.enforced}}.

The save is refused until at least one active Owner or Admin of the workspace has an Inflect password. That person keeps a way in if your identity provider ever stops working: an Owner or Admin who signs in with their password can still open the workspace. This is called break-glass access.

If you signed in to Inflect with Google or Microsoft, sign out first, and sign in with your password or through single sign-on. Otherwise the workspace closes to you as soon as you save.

To stop enforcing, untick **{{ui:admin.sso.enforceSso}}** and save.

### Change a saved configuration

Edit the fields and click **{{ui:admin.sso.saveConfig}}**. Only an Owner can change the fields that say which identity provider to trust. Saving such a change unlinks every member from the configuration: nobody is signed out, and each member's next sign-in through single sign-on links their account again by email. Dots left in the {{ui:admin.sso.clientSecret}} or {{ui:admin.sso.certificate}} keep the stored value. If there is no real value stored for them to keep, the save is refused. Paste the real value and save again.

### Switch single sign-on off, or delete it

To switch it off but keep the settings, untick **{{ui:admin.sso.enableSso}}** and **{{ui:admin.sso.enforceSso}}**, then save. Members then sign in the ways they did before.

To delete the configuration, click **{{ui:admin.sso.delete}}**, then **{{ui:admin.sso.deleteConfirm}}** in the dialog. Deleting removes the configuration and every link between members' Inflect accounts and the identity provider, and ends enforcement if this configuration carried it. It cannot be undone. The message **{{ui:admin.sso.deletedOk}}** appears. If you set single sign-on up again later, each member's first sign-in links their account again.

## What happens next

- **Members sign in from the Inflect sign-in page.** They click **{{ui:login.sso.continue}}**, type the workspace's short name in **{{ui:login.sso.workspaceLabel}}** and click **{{ui:login.sso.submit}}**. The short name is the part of the workspace's address after `/t/`. If both an OIDC and a SAML configuration are enabled, they then choose one by its {{ui:admin.sso.providerName}}.
- **The first sign-in links the account.** The first time someone signs in through your identity provider, Inflect links that identity to their Inflect account. After that, they must sign in with the same account at the identity provider.
- **A single sign-on sign-in opens this workspace only.** Someone who belongs to several workspaces signs in to the others separately.
- **Multi-factor authentication still applies.** When the workspace's policy on the **{{ui:admin.nav.security}}** page asks for a code, a sign-in through single sign-on asks for one too.
- **While single sign-on is enforced,** members reach this workspace only by signing in through it. A password, Google or Microsoft sign-in no longer opens it, and anyone already signed in one of those ways loses access to it. The exception is break-glass access: an Owner or Admin who has a password and signs in with it. Someone who belongs to other workspaces as well can still open those after a password, Google or Microsoft sign-in, just not this one.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:admin.sso.loading}}**, with grey bars | The page is loading the saved configurations | Wait a moment |
| {{ui:admin.sso.notConfigured}}, with an empty card | Nothing is saved for this protocol | Fill in the card and save, or switch protocol to see the other configuration |
| **{{ui:admin.sso.loadFailed}}**, with a reason below it | The page could not load the saved configurations. It shows no card, so nothing can be saved over them | Click **{{ui:common.error.tryAgain}}**, or reload the page |
| **{{ui:admin.sso.manageOnly}}** | Your role opens the admin pages but does not manage the workspace, so the page shows no settings | Ask an Owner or an Admin to make the change |
| **Only an Owner can set up single sign-on or change whom it trusts…** when you save | You are not an Owner, and the save would set up single sign-on or change which identity provider it trusts | Ask an Owner to make that change. You can still save the other settings |
| **Invalid request payload** when you save | A required field is empty, or a value is not in the expected form | Fill in every field for the protocol. URLs must be full web addresses, and domains look like `acme.com` |
| **Enter the client secret for this provider.** or **Enter the certificate for this provider.** when you save | The dots have no stored value to keep | Paste the real value into the field and save |
| **Cannot enforce SSO: at least one admin must have a local password for break-glass access** when you save | **{{ui:admin.sso.enforceSso}}** is ticked, and no active Owner or Admin of the workspace has an Inflect password | Set a password on one of those accounts, then save again |
| **A resource with that unique constraint already exists** when you save | Your OIDC and SAML configurations have the same {{ui:admin.sso.providerName}} | Give this configuration a different name |
| **{{ui:admin.sso.saveFailed}}** or **{{ui:admin.sso.unknownError}}** when you save | The save did not go through, and the reason was not given | Reload the page and try again |
| No **{{ui:admin.sso.testLogin}}** button | The saved configuration is not enabled | Tick **{{ui:admin.sso.enableSso}}** and save |
| The test tab shows the Inflect sign-in page with a message | The test sign-in failed | Look the message up in [Set up single sign-on](../../how-to/set-up/set-up-single-sign-on.md) |
| A message in red after you confirm **{{ui:admin.sso.deleteConfirm}}**, such as **{{ui:admin.sso.deleteFailed}}** | The deletion did not go through, and the configuration is still saved. The message gives the reason | Reload the page and try again |

## Related

- [Set up single sign-on](../../how-to/set-up/set-up-single-sign-on.md) walks through both protocols step by step, and explains every message a failed sign-in can show.
- [Invite a colleague](../../how-to/set-up/invite-a-colleague.md): single sign-on lets in only people who are already members.
- [{{ui:admin.security.title}}](security.md) sets the workspace's multi-factor authentication policy, which applies to single sign-on too.
