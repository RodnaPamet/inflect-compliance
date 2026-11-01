---
route: /t/[tenantSlug]/admin/scim
---

# {{ui:admin.scim.title}}

The {{ui:admin.scim.title}} page lets your identity provider, such as Okta, Microsoft Entra ID or OneLogin, create, update and deactivate this workspace's members for you. Owners and Admins create the token the identity provider signs in with, copy the address it sends to, and revoke tokens that are no longer needed.

## Where to find it

Click **{{ui:nav.admin}}**, the gear icon at the bottom of the sidebar. The {{ui:admin.title}} page opens. Click **{{ui:admin.nav.scim}}**. The breadcrumb reads **{{ui:admin.crumb.dashboard}}** › **{{ui:admin.crumb.admin}}** › **{{ui:admin.scim.crumbSelf}}**.

The strip under the title, **{{ui:admin.identityNav.label}}**, links the four identity pages: **{{ui:admin.identityNav.sso}}**, **{{ui:admin.identityNav.scim}}**, **{{ui:admin.identityNav.entra}}** and **{{ui:admin.identityNav.integrations}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page and see the address and the tokens | Owner, Admin |
| Create a token | Owner, Admin |
| Revoke a token | Owner, Admin |

Editors, Readers, Auditors and AI admins see **{{ui:admin.forbidden.title}}** instead of the page.

## What it is for

SCIM is the standard way an identity provider keeps another system's users in step with its own. Once it is set up, the identity provider adds a person to the workspace when they are assigned the Inflect app, changes their details when they change, and deactivates them when they leave or are unassigned, without anyone opening the [{{ui:admin.members.title}}](members.md) page.

SCIM manages who is a member. It does not sign anyone in: that is [{{ui:admin.sso.title}}](sso.md).

## What you see

**The status pill**, at the top right: **{{ui:admin.scim.enabled}}** while at least one token is active, **{{ui:admin.scim.notConfigured}}** otherwise.

**{{ui:admin.scim.endpointHeading}}.** The address your identity provider sends to, with a copy button.

**{{ui:admin.scim.tokensHeading}}.** Each active token, with its label, the date it was created and, once the identity provider has used it, the date it was last used. Below the active tokens, a fold names how many tokens were revoked earlier and lists them, marked **{{ui:admin.scim.revoked}}**, with the date each was revoked.

**{{ui:admin.scim.setupHeading}}.** The steps to follow in your identity provider, and how roles are given.

## What you can do

### Create a token

1. In {{ui:admin.scim.tokensHeading}}, click **{{ui:admin.scim.tokenBtn}}**.
2. Under **{{ui:admin.scim.tokenLabel}}**, say where it is used, such as Okta SCIM. Left empty, it is called SCIM Token.
3. Click **{{ui:admin.scim.create}}**.

A yellow box, **{{ui:admin.scim.newTokenTitle}}**, shows the token. Click **{{ui:admin.scim.copy}}** and paste it into your identity provider straight away: Inflect keeps only a fingerprint of it, so it is never shown again. Click **{{ui:admin.scim.dismissCopied}}** when you have it.

You can have several active tokens, for example one per identity provider, or a new one while you move off an old one.

### Set up your identity provider

In your identity provider, add a SCIM 2.0 provisioning connector for Inflect, then:

1. Set the SCIM connector base URL to the address under **{{ui:admin.scim.endpointHeading}}**.
2. Set authentication to an HTTP header with the token as a bearer token.
3. Turn on the provisioning actions: create users, update user attributes and deactivate users.
4. Test the connection from your identity provider.

### How roles are given

A person the identity provider adds becomes a **Reader**, unless the identity provider sends a role. It can send **Reader**, **Editor** or **Auditor**. It cannot make anyone an **Admin** or an **Owner**: an Owner or Admin sets those on the [{{ui:admin.members.title}}](members.md) page.

Groups the identity provider pushes can also give roles, through the group mappings on the [{{ui:admin.entra.title}}](entra.md) page.

### Revoke a token

Click **{{ui:admin.scim.revoke}}** on the token, then **{{ui:admin.scim.revokeConfirm}}** to confirm. The page says **{{ui:admin.scim.revokedToast}}**, and any identity provider using it is refused from then on. A revoked token cannot be brought back; create a new one.

Creating and revoking a token are both recorded in the [{{ui:admin.auditLog}}](audit-log.md), with who did it and the token's label.

## What happens next

- The identity provider's changes show on the [{{ui:admin.members.title}}](members.md) page. A person it deactivates is marked deactivated and loses access to the workspace; the identity provider can reactivate them later.
- When the identity provider deactivates an AI admin, the workspace's Owners are notified.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:admin.scim.noActive}}** | No token is active, so no identity provider can provision | Create a token |
| **{{ui:admin.scim.errNoPermission}}** | Your role cannot manage SCIM | Ask an Owner or Admin |
| **{{ui:admin.scim.errGenerate}}**, or the server's reason | The token was not created | Try again, or act on the reason |
| **{{ui:admin.scim.errRevoke}}**, or the server's reason | The token was not revoked, and still works | Try again. If the token was already revoked or no longer exists, reload the page |
| **{{ui:admin.scim.errLoad}}** | The page could not read the tokens | Reload the page |
| **{{ui:admin.forbidden.title}}** | Your role cannot use the admin pages | Ask an Owner or Admin |

## Related

- [{{ui:admin.sso.title}}](sso.md), which signs people in through the same identity provider.
- [{{ui:admin.entra.title}}](entra.md), which maps directory groups to roles.
- [{{ui:admin.members.title}}](members.md), where provisioned members appear.
