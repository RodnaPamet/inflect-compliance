---
route: /t/[tenantSlug]/notifications
---

# {{ui:notifications.title}}

Inflect sends you a notification when something needs you: a policy to acknowledge, evidence approved or rejected, a vendor review due, questions assigned to you. You read them from the bell at the top of the page, and the {{ui:notifications.title}} page lists the latest ones for one workspace.

## Where to find it

**The bell.** The bell at the top right of every page shows how many notifications you have not read. Click it to open the list.

**The page.** The {{ui:notifications.title}} page has no link in the app. Open it by going to `notifications` under the workspace's address, for example `…/t/your-workspace/notifications`. The breadcrumb reads **{{ui:notifications.crumbDashboard}}** › **{{ui:notifications.title}}**.

## Who can use it

Everyone, for their own notifications. Every role sees only the notifications sent to them, and nobody can see anyone else's.

## What it is for

Use the bell to keep up with what needs your attention and to jump straight to it. The page is a plain list of the same notifications for one workspace.

## What you see

**The bell's list.** Your latest notifications, newest first, each with its title and message. An unread one is marked. Click a notification to mark it read and, when it is about a record, to open that record. **{{ui:panels.bell.markAllRead}}** at the top marks them all read. When there is nothing, the list reads **{{ui:panels.bell.allClear}}**.

The bell's list belongs to the workspace you first joined. If you belong to several workspaces, it shows that workspace's notifications whichever workspace you have open, and notifications from the others do not appear in it.

**The page.** The 50 latest notifications for the workspace in the address, newest first. Each shows an icon for its kind, its message and when it was sent. An unread one has a coloured edge and **{{ui:notifications.markRead}}**; a read one is faded. The page does not show a notification's title or link to the record it is about.

## What you can do

### Mark a notification read

On the page, click **{{ui:notifications.markRead}}**. In the bell, click the notification, or **{{ui:panels.bell.markAllRead}}** for all of them. The change shows at once. If it cannot be saved, the page shows the notification as unread again.

## What happens next

- Reading a notification does not delete it.
- Some notifications are also sent by email, depending on the workspace's notification settings. See [{{ui:admin.notifications.title}}](../admin/notifications.md).

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:notifications.noNotifications}}** | You have no notifications in this workspace. The page also shows this while it is still loading | Wait a moment; nothing else to do |
| **{{ui:panels.bell.sessionExpired}}**, in the bell | You were signed out | Click **{{ui:panels.bell.sessionExpiredAction}}** |

## Related

- [{{ui:admin.notifications.title}}](../admin/notifications.md), where Owners and Admins choose which notifications are sent and how.
