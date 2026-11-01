---
route: /t/[tenantSlug]/admin/entra
---

# {{ui:admin.entra.title}}

The {{ui:admin.entra.title}} page connects the workspace to your organization's Microsoft Entra ID directory, so that the groups people belong to there set their role here when they sign in with Microsoft. An Owner names the directory; Owners and Admins then map directory groups to roles and decide whether people outside every mapped group may get in at all.

## Where to find it

Click **{{ui:nav.admin}}**, the gear icon at the bottom of the sidebar. The {{ui:admin.title}} page opens. Click **{{ui:admin.nav.entra}}**. The breadcrumb reads **{{ui:admin.crumb.dashboard}}** › **{{ui:admin.crumb.admin}}** › **{{ui:admin.entra.crumbSelf}}**, and its steps go back.

The strip under the title, **{{ui:admin.identityNav.label}}**, links the four identity pages: **{{ui:admin.identityNav.sso}}**, **{{ui:admin.identityNav.scim}}**, **{{ui:admin.identityNav.entra}}** and **{{ui:admin.identityNav.integrations}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page | Owner, Admin |
| Set up the directory, or change its {{ui:admin.entra.directoryId}} or {{ui:admin.entra.appClientId}} | Owner |
| Change the allowed domains and the group gate | Owner, Admin |
| Add or remove a mapping to Admin, Editor, Reader or Auditor | Owner, Admin |
| Add or remove a mapping to AI admin | Owner |

An Admin sees the two ID fields greyed out, with a note saying only an Owner can change them. Before the directory is set up, an Admin cannot save the form at all. Editors, Readers, Auditors and AI admins see **{{ui:admin.forbidden.title}}** instead of the page.

The directory decides whose sign-ins the mappings apply to, which is why only an Owner sets it.

## What it is for

Most organizations already keep who-does-what in their directory: a Security team group, an Auditors group, and so on. Mapping those groups here means a person's role in the workspace follows the directory. Someone moved into the Auditors group gets the Auditor role at their next Microsoft sign-in, without anyone changing it on the [{{ui:admin.members.title}}](members.md) page. With the group gate on, someone in none of the mapped groups cannot get in.

The mappings apply in every workspace a person belongs to, each under its own settings. A Microsoft sign-in is checked against this workspace's directory, domains, mappings and gate whether or not this is the first workspace they joined.

## What you see

**{{ui:admin.entra.step1Title}}.** {{ui:admin.entra.signInApp.consent}} The card shows the sign-in app's **{{ui:admin.entra.appClientId}}**, so your administrator can find it. {{ui:admin.entra.signInApp.groups}}

Under **{{ui:admin.entra.signInApp.selfHostedTitle}}**, the card gives the redirect URI to set on your own app registration, and the groups claim to add to it. These apply only when Inflect runs on your own infrastructure and its sign-in app is your registration. **{{ui:admin.entra.openPortal}}** opens the Entra admin center.

**{{ui:admin.entra.step2Title}}.** The form:

| Field | What it is |
| --- | --- |
| {{ui:admin.entra.directoryId}} | Your Microsoft directory's ID. {{ui:admin.entra.directoryIdHint}} |
| {{ui:admin.entra.appClientId}} | {{ui:admin.entra.appClientIdHint}} When it is not the app this deployment signs in with, a note says so |
| {{ui:admin.entra.allowedDomains}} | The email domains your people sign in with, such as contoso.com. {{ui:admin.entra.allowedDomainsHint}} |
| {{ui:admin.entra.enforceGate}} | **{{ui:admin.entra.off}}** or **{{ui:admin.entra.on}}**. {{ui:admin.entra.enforceGateHint}} |

**{{ui:admin.entra.configured}}** appears beside the title once the directory has been saved.

**{{ui:admin.entra.mappings.title}}.** Each mapping, with the group's display name (or its object ID), the role it gives and its priority, and a bin icon to remove it. Below the list, a row adds a mapping.

## What you can do

### Set up the directory

1. Have an administrator of your directory consent to the sign-in app named in step 1, or follow the self-hosted steps if the app is your own.
2. Enter the **{{ui:admin.entra.directoryId}}** and the **{{ui:admin.entra.appClientId}}**. Both are long IDs of the form 00000000-0000-0000-0000-000000000000.
3. Click **{{ui:admin.entra.save}}**. The form says **{{ui:admin.entra.saved}}**

Changing the directory or the client ID later is an Owner's action too.

### Map a group to a role

1. In the add row, enter the group's **{{ui:admin.entra.mappings.groupObjectId}}** from the Entra admin center, and, if you like, a **{{ui:admin.entra.mappings.displayName}}** so the list is readable.
2. Choose the **{{ui:admin.entra.mappings.role}}**: Admin, Editor, Reader or Auditor, or, for an Owner, AI admin. {{ui:admin.entra.mappings.roleHint}}
3. Set the **{{ui:admin.entra.mappings.priority}}**, from 0 to 1000.
4. Click **{{ui:admin.entra.mappings.addMapping}}**.

Each group can be mapped once.

### How a role is chosen

When someone signs in with Microsoft from your directory, Inflect looks at the mapped groups they are in:

- The mapping with the **highest priority** wins, and their role becomes that mapping's role.
- When two of their groups share the top priority, the more senior role wins. AI admin is the exception: {{ui:admin.entra.mappings.aiAdminTieHint}}
- Someone in **no** mapped group keeps the role they have. With the group gate on, they are refused instead.
- A sign-in from another Microsoft directory, or from a domain not on a non-empty allowed list, gets no role from the mappings. With the group gate on, it is refused instead.
- An **Owner's** role never changes, and the gate never refuses an Owner.
- A member with a custom role keeps it, and is not moved into a role their custom role cannot go with.

Group pushes from your identity provider through [{{ui:admin.scim.title}}](scim.md) use the same mappings.

### Turn the group gate on

Set **{{ui:admin.entra.enforceGate}}** to **{{ui:admin.entra.on}}** and click **{{ui:admin.entra.save}}**. From then on, a Microsoft sign-in to this workspace is refused when it matches none of the mappings, comes from any directory other than yours, or comes from a domain not on the allowed list. It only takes effect once at least one mapping exists.

A refusal lasts until the person next signs in with Microsoft. Until then the workspace is not offered to them, and if it was their only one they are told that Microsoft Entra ID did not admit the sign-in and to ask an admin of the workspace. Their other workspaces are not affected.

### Remove a mapping

Click the bin icon on its row. It leaves the list at once, and a message offers **{{ui:admin.entra.mappings.undo}}** for 5 seconds; after that it is removed. People keep the role it gave them until a later sign-in sets another.

## What happens next

- Setting up or changing the directory and adding or removing a mapping add an entry to the workspace's audit log, naming who did it.
- Roles change at each person's next Microsoft sign-in, not straight away.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:admin.entra.mappings.emptyTitle}}** | No group gives a role yet | Add a mapping |
| **{{ui:admin.entra.setupOwnerOnly}}** | You are an Admin and the directory is not set up | Ask an Owner |
| **{{ui:admin.entra.directoryOwnerOnly}}** | You are an Admin | Ask an Owner to change the IDs |
| **{{ui:admin.entra.loadFailed}}** | The settings did not load. Saving is off, so nothing is overwritten | Reload the page |
| **{{ui:admin.entra.saveFailedGuids}}** | One of the two IDs is not in the right form | Copy it again from the Entra admin center, then save |
| **{{ui:admin.entra.saveFailed}}**, or a reason from the server | The form was not saved | Act on the reason, then save again |
| **{{ui:admin.entra.mappings.loadFailed}}** | The mappings did not load | Reload the page |
| **{{ui:admin.entra.mappings.errExists}}** | That group is already mapped | Remove the old mapping first |
| **{{ui:admin.entra.mappings.errInvalidGuid}}** | The group ID is not in the right form | Copy it again from the Entra admin center |
| A reason from the server, such as that only an Owner can map a group to AI admin | The mapping was not added | Act on the reason |
| **{{ui:admin.entra.mappings.errRemove}}** | The mapping was not removed, and is back in the list | Try again |
| **{{ui:admin.forbidden.title}}** | Your role cannot use the admin pages | Ask an Owner or Admin |

## Related

- [{{ui:admin.sso.title}}](sso.md), for sign-in through other identity providers.
- [{{ui:admin.scim.title}}](scim.md), whose group pushes use the same mappings.
- [{{ui:admin.members.title}}](members.md), where the roles the mappings give appear.
