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

An Admin whose membership carries a custom role can use the page only if the custom role is built on Admin and can manage the workspace's settings. Any other custom role sees **{{ui:admin.forbidden.title}}**, or **{{ui:admin.notifications.loadFailed}}** in place of the settings.

## What it is for

Inflect emails people when something needs them: a task assigned, evidence about to expire, a policy waiting for approval, a leaver found. Those emails wait in a queue, the outbox, which Inflect sends every 10 minutes. This page decides whether they are sent at all, under which name and address, and whether a compliance mailbox gets a blind copy of each. Its last section decides which agent events notify everyone in the workspace through the bell.

The settings cover the outbox emails, the weekly compliance digest and the emails that deliver scheduled risk reports. Invitations to join the workspace and account emails, such as a password reset or email verification, are different: they come from the platform's own address, are not copied to the compliance mailbox, and are sent even while email notifications are off.

## What you see

**The header.** The page title, a badge reading **{{ui:admin.notifications.enabled}}** or **{{ui:admin.notifications.disabled}}**, and two buttons, **{{ui:admin.notifications.processOutbox}}** and **{{ui:admin.notifications.dailySweep}}**. The badge shows the saved setting, so it changes only after you save.

**{{ui:admin.notifications.tabSettings}} and {{ui:admin.notifications.tabStats}}.** Two views, one at a time.

**{{ui:admin.notifications.tabSettings}}.**

| Setting | What it does |
| --- | --- |
| {{ui:admin.notifications.enableToggle}} | Whether the workspace sends notification emails, the weekly compliance digest and scheduled risk report emails. On by default |
| {{ui:admin.notifications.senderName}} | The name those emails come from. Required, up to 200 characters |
| {{ui:admin.notifications.senderEmail}} | The address those emails come from. Inflect fills in a default |
| {{ui:admin.notifications.complianceMailbox}} | An optional address that receives a blind copy of each of those emails |
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

- **Sender.** Change the address only to one Inflect's mail service is allowed to send from. Any other address makes every outbox email fail, and the failures show under {{ui:admin.notifications.colFailed}}. The weekly digest and scheduled report emails fail too, and those failures are not counted here.
- **Compliance mailbox.** Enter an address to copy every notification email, every weekly digest and every scheduled report email, attachment included, to it. The digest is copied once for each person it is sent to. Clear the field to stop.
- **Email off.** Switch off {{ui:admin.notifications.enableToggle}}. No new outbox emails are queued while it is off. Emails already queued wait, and are sent once you switch it back on. The weekly digest is not sent, and scheduled risk reports are still produced but not emailed; neither is sent later when you switch email back on.
- **The bell.** Switch off an agent event to stop it notifying anyone. Inflect stops creating that notification, so it never reaches the bell, its list or the unread count. It affects everyone in the workspace.

If the sender name is empty or an address is not a valid email address, the save is refused and nothing is saved. The page keeps what you typed, shows **{{ui:admin.notifications.saveFailed}}** beside the button, and marks the field that was refused. Correct it and save again.

### Send queued email now

Click **{{ui:admin.notifications.processOutbox}}**. A dialog titled **{{ui:admin.notifications.runOutboxConfirmTitle}}** opens; click **{{ui:admin.notifications.runOutboxConfirm}}**. Inflect sends up to 100 of this workspace's queued emails straight away, instead of at the next 10-minute run. The button reads **{{ui:admin.notifications.sending}}** while it works. A message, **{{ui:admin.notifications.outboxResultTitle}}**, then gives the counts sent, failed and skipped, and the {{ui:admin.notifications.tabStats}} view is refreshed. Settings you have changed but not saved are kept.

### Run the daily evidence sweep now

Click **{{ui:admin.notifications.dailySweep}}**. A dialog titled **{{ui:admin.notifications.runSweepConfirmTitle}}** opens; click **{{ui:admin.notifications.runSweepConfirm}}**. Inflect runs this workspace's daily evidence check, which normally runs at 06:00 UTC: it creates reminder tasks for evidence that expires within 30, 7 or 1 days, skipping any it has reminded about already. It then sends this workspace's queued email. A message, **{{ui:admin.notifications.sweepResultTitle}}**, gives the reminder tasks created, those already reminded about, and the emails sent, failed and skipped.

## What happens next

- Saved settings apply to the next email the outbox sends.
- Each save that changes a setting is recorded in the workspace's audit log, with the settings changed and their values before and after. A save that changes nothing records nothing.
- A failed email is tried up to three times in all. After the third failure it counts under {{ui:admin.notifications.colFailed}} and is not tried again.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:admin.forbidden.title}}** | Your role cannot use the admin pages | Ask an Owner or Admin |
| **{{ui:admin.notifications.loadFailed}}** | The settings did not load. The reason the server gave, if any, is shown below it. A custom role that cannot manage the workspace's settings also sees this | Click **{{ui:common.error.tryAgain}}**. If it persists, ask an Owner to check your role |
| **{{ui:admin.notifications.saveFailed}}** beside the button | The save was refused and nothing was saved. A refused field is marked {{ui:admin.notifications.senderNameInvalid}} or {{ui:admin.notifications.emailInvalid}} | Correct the field and save again |
| **{{ui:admin.notifications.triggerFailed}}**, or the reason the server gave, after a button | The job did not run | Try again |

## Related

- [{{ui:admin.members.title}}](members.md), whose invitations are emailed directly rather than through the outbox.
- [{{ui:admin.integrations.title}}](integrations.md), whose syncs raise some of the emails sent from here.
- [{{ui:admin.security.title}}](security.md), for the workspace's other security settings.
