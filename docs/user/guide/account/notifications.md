---
route: /t/[tenantSlug]/notifications
---

# {{ui:notifications.title}}

Inflect sends you a notification when something needs you: a policy to acknowledge, evidence approved or rejected, a vendor review due, questions assigned to you. You read them from the bell at the top of the page, and the {{ui:notifications.title}} page lists the latest ones for the workspace you have open.

## Where to find it

**The bell.** The bell at the top right of every page shows how many notifications you have not read in the workspace you have open. Click it to open the list.

**The page.** Click **{{ui:panels.bell.viewAll}}** at the bottom of the bell's list. The breadcrumb reads **{{ui:notifications.crumbDashboard}}** › **{{ui:notifications.title}}**.

## Who can use it

Everyone, for their own notifications. Every role sees only the notifications sent to them, and nobody can see anyone else's.

## What it is for

Use the bell to keep up with what needs your attention and to jump straight to it. The page is a plain list of the same notifications for one workspace.

## What you see

**The bell's list.** Your latest notifications, newest first, each with its title and message. An unread one is marked. Click a notification to mark it read and, when it is about a record, to open that record. **{{ui:panels.bell.markAllRead}}** at the top marks them all read. When there is nothing, the list reads **{{ui:panels.bell.allClear}}**.

The bell shows the notifications of the workspace you have open. If you belong to several workspaces, switching workspace switches the bell's list and its count. On organization pages, which belong to no workspace, it shows those of the workspace you first joined, and has no link to the page.

**The page.** The 50 latest notifications for the workspace, newest first. Each shows an icon for its kind, its title, its message and when it was sent, and **{{ui:notifications.open}}** when it is about a record. An unread one has a coloured edge and **{{ui:notifications.markRead}}**; a read one is faded.

## What you can do

### Mark a notification read

On the page, click **{{ui:notifications.markRead}}**, or **{{ui:notifications.open}}**, which opens the record and marks the notification read. In the bell, click the notification, or **{{ui:panels.bell.markAllRead}}** for all of them. The change shows at once. If it cannot be saved, the page shows the notification as unread again.

## What happens next

- Reading a notification does not delete it.
- Some notifications are also sent by email, depending on the workspace's notification settings. See [{{ui:admin.notifications.title}}](../admin/notifications.md).

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:notifications.loading}}** | The page is loading | Wait a moment |
| **{{ui:notifications.noNotifications}}** | You have no notifications in this workspace | Nothing to do |
| **{{ui:notifications.loadError}}** | The list could not be loaded | Reload the page |
| **{{ui:panels.bell.sessionExpired}}**, in the bell | You were signed out | Click **{{ui:panels.bell.sessionExpiredAction}}** |

## Related

- [{{ui:admin.notifications.title}}](../admin/notifications.md), where Owners and Admins choose which notifications are sent and how.
