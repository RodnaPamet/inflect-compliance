---
route: /t/[tenantSlug]/admin/notifications
---

# {{ui:admin.notifications.title}}

The {{ui:admin.notifications.title}} page controls the email this workspace sends and which agent events ring the in-app bell. Owners and Admins use it to set who emails come from, copy them to a compliance mailbox, switch email off, and see how many emails were sent or failed.

## Where to find it

Click **{{ui:nav.admin}}**, the gear icon at the bottom of the sidebar. The {{ui:admin.title}} page opens. Under {{ui:admin.section.organization}}, click **{{ui:admin.nav.notifications}}**. The breadcrumb reads **{{ui:admin.crumb.dashboard}}** › **{{ui:admin.crumb.admin}}** › **{{ui:admin.crumb.notifications}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page, its settings and its send stats | Owner, Admin |
| Change and save the settings | Owner, Admin |
| Use **{{ui:admin.notifications.processOutbox}}** and **{{ui:admin.notifications.dailySweep}}** | Owner, Admin |

Editors, Readers, Auditors and AI admins see **{{ui:admin.forbidden.title}}** instead of the page.

If your workspace uses custom roles, this page follows the custom role's base role. An Admin whose custom role is built on Editor, Auditor or Reader sees the page stay on its loading placeholder, and cannot save or run anything.

## What it is for

Inflect emails people when something needs them: a task assigned, evidence about to expire, a policy waiting for approval, a leaver found. Those emails wait in a queue, the outbox, which Inflect sends every 10 minutes. This page decides whether they are sent at all, under which name and address, and whether a compliance mailbox gets a blind copy of each. Its last section decides which agent events notify everyone in the workspace through the bell.

Not every email goes through these settings. Invitations, the weekly compliance digest, scheduled risk reports and sign-in emails, such as a password reset, are sent directly: they do not use the sender set here, are not copied to the compliance mailbox, and are sent even while email notifications are off.

## What you see

**The header.** The page title, a badge reading **{{ui:admin.notifications.enabled}}** or **{{ui:admin.notifications.disabled}}**, and two buttons, **{{ui:admin.notifications.processOutbox}}** and **{{ui:admin.notifications.dailySweep}}**. The badge follows the switch below as soon as you change it, before you save.

**{{ui:admin.notifications.tabSettings}} and {{ui:admin.notifications.tabStats}}.** Two views, one at a time.

**{{ui:admin.notifications.tabSettings}}.**

| Setting | What it does |
| --- | --- |
| {{ui:admin.notifications.enableToggle}} | Whether the workspace sends the emails that go through the outbox. On by default |
| {{ui:admin.notifications.senderName}} | The name emails come from. Required |
| {{ui:admin.notifications.senderEmail}} | The address emails come from. Inflect fills in a default |
| {{ui:admin.notifications.complianceMailbox}} | An optional address that receives a blind copy of every outbox email |
| {{ui:admin.notifications.inAppTitle}} | {{ui:admin.notifications.inAppDescription}} |

Under {{ui:admin.notifications.inAppTitle}}, one switch per agent event: an agent's kill switch engaged, an agent proposal quarantined, an agent's circuit breaker tripped, a tool definition approved for the workspace, an agent's risk assessment out of date, and an agent's owner leaving the workspace. Each is on by default. The event names are shown in English whatever your language, because the notifications themselves are written in English.

**{{ui:admin.notifications.tabStats}}.** How many emails the workspace queued in the {{ui:admin.notifications.last24h}}, {{ui:admin.notifications.last7d}} and {{ui:admin.notifications.last30d}}, by outcome:

| Column | What it counts |
| --- | --- |
| {{ui:admin.notifications.colPending}} | Emails waiting to be sent, including any being tried again after a failure |
| {{ui:admin.notifications.colSent}} | Emails handed to the mail service |
| {{ui:admin.notifications.colFailed}} | Emails that failed three times and will not be tried again |
| {{ui:admin.notifications.colTotal}} | The three added together |

## What you can do

### Change the settings

Change any setting on **{{ui:admin.notifications.tabSettings}}**, then click **{{ui:admin.notifications.saveSettings}}**. Everything on the view is saved together. **{{ui:admin.notifications.savedSuccess}}** shows for two seconds.

- **Sender.** Change the address only to one Inflect's mail service is allowed to send from. Any other address makes every outbox email fail, and the failures show under {{ui:admin.notifications.colFailed}}.
- **Compliance mailbox.** Enter an address to copy every outbox email to it. Clear the field to stop.
- **Email off.** Switch off {{ui:admin.notifications.enableToggle}}. No new outbox emails are queued while it is off. Emails already queued wait, and are sent once you switch it back on.
- **The bell.** Switch off an agent event to stop it notifying anyone. Inflect stops creating that notification, so it never reaches the bell, its list or the unread count. It affects everyone in the workspace.

Fill in every field correctly before you save. If the sender name is empty or an address is not a valid email address, the save is refused and the page stops with an error instead of saying which field is wrong. Nothing is saved. Reload the page to see the settings as they were.

### Send queued email now

Click **{{ui:admin.notifications.processOutbox}}** and confirm in your browser. Inflect sends up to 100 of this workspace's queued emails straight away, instead of at the next 10-minute run. A browser message then gives the counts sent, failed and skipped. The button reads **{{ui:admin.notifications.sending}}** while it works.

### Run the daily evidence sweep now

Click **{{ui:admin.notifications.dailySweep}}** and confirm in your browser. Inflect runs this workspace's daily evidence check, which normally runs at 06:00 UTC: it creates reminder tasks for evidence that expires within 30, 7 or 1 days, skipping any it has reminded about already. It then sends queued email. A browser message gives the counts.

## What happens next

- Saved settings apply to the next email the outbox sends.
- Changes on this page are not recorded in the workspace's audit log.
- A failed email is tried up to three times in all. After the third failure it counts under {{ui:admin.notifications.colFailed}} and is not tried again.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:admin.forbidden.title}}** | Your role cannot use the admin pages | Ask an Owner or Admin |
| A grey placeholder that never goes away | The settings did not load, for example because your custom role cannot read them | Reload the page. If it persists, ask an Owner to check your role |
| A browser message starting **Error:** after a button | The job did not run | Reload the page and try again |
| The page stops with an error after **{{ui:admin.notifications.saveSettings}}** | A field was empty or not a valid address, and the save was refused | Reload the page, correct the field and save again |

## Related

- [{{ui:admin.members.title}}](members.md), whose invitations are emailed directly rather than through the outbox.
- [{{ui:admin.integrations.title}}](integrations.md), whose syncs raise some of the emails sent from here.
- [{{ui:admin.security.title}}](security.md), for the workspace's other security settings.
