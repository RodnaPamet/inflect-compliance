---
route: /t/[tenantSlug]/admin
---

# {{ui:admin.title}}

The {{ui:admin.title}} page is the way into every workspace setting. It holds no settings of its own: it lists the admin pages in groups, as buttons, and has a switch for the colour theme.

## Where to find it

Click **{{ui:nav.admin}}**, the gear icon at the bottom of the sidebar. The breadcrumb reads **{{ui:admin.crumb.dashboard}}** › **{{ui:admin.title}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page and its buttons | Owner, Admin |

Editors, Readers, Auditors and AI admins see **{{ui:admin.forbidden.title}}** instead of the page. An AI admin reaches the agent pages from **{{ui:nav.agents}}** in the sidebar instead.

Opening the page does not mean you can use every page it lists. Some pages are for Owners only, and say so when an Admin opens them.

## What you see

**The header.** The page title, and on the right **{{ui:admin.nav.theme}}** with a switch between the light and dark theme. The theme is yours alone: it changes how Inflect looks for you, on this device, and nobody else.

**The groups.** Each group has a heading and a row of buttons, one per admin page:

| Group | Pages |
| --- | --- |
| {{ui:admin.section.identity}} | {{ui:admin.nav.sso}}, {{ui:admin.nav.scim}}, {{ui:admin.nav.entra}} |
| {{ui:admin.section.integrations}} | {{ui:admin.nav.integrations}} |
| {{ui:admin.section.people}} | {{ui:admin.nav.members}}, {{ui:admin.nav.rbac}}, {{ui:admin.nav.roles}}, {{ui:admin.nav.personnel}}, {{ui:admin.nav.devices}}, {{ui:admin.nav.training}} |
| {{ui:admin.section.organization}} | {{ui:admin.nav.apiKeys}}, {{ui:admin.nav.billing}}, {{ui:admin.nav.notifications}}, {{ui:admin.nav.modules}}, {{ui:admin.nav.aiFeatures}} |
| {{ui:admin.section.security}} | {{ui:admin.nav.security}}, {{ui:admin.nav.trustCenter}}, {{ui:admin.auditLog}}, {{ui:admin.nav.agentCredentials}} |
| {{ui:admin.section.privacyData}} | {{ui:admin.nav.privacy}}, {{ui:admin.nav.dsarRequests}} |
| {{ui:admin.section.risk}} | {{ui:admin.nav.riskMatrix}}, {{ui:admin.nav.riskAppetite}} |
| {{ui:admin.section.vendors}} | {{ui:admin.nav.vendorTemplates}}, {{ui:admin.nav.vendorReviews}} |

## What you can do

- **Open a setting.** Click its button. Each page has a back link that returns here.
- **Change the theme.** Click the switch beside **{{ui:admin.nav.theme}}**. The change is immediate.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:admin.forbidden.title}}** | Your role cannot use the admin pages | Ask an Owner or Admin |

## Related

- [{{ui:admin.members.title}}](members.md), to invite people and change their roles.
- [{{ui:admin.security.title}}](security.md), for sign-in and session rules.
- [{{ui:admin.nav.aiFeatures}}](ai-features.md), [{{ui:admin.nav.modules}}](modules.md) and [{{ui:admin.nav.billing}}](billing.md), the other workspace-wide settings.
