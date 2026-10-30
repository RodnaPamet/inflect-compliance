---
route: /t/[tenantSlug]/admin/personnel
---

# {{ui:personnel.title}}

The {{ui:personnel.title}} page is the workspace's employee roster: everyone your HR system reports, with their employment status, department and job title. Owners and Admins use it to check what Inflect knows about the people behind the workspace's accounts.

## Where to find it

Click **{{ui:nav.admin}}**, the gear icon at the bottom of the sidebar. The {{ui:admin.title}} page opens. Under {{ui:admin.section.people}}, click **{{ui:admin.nav.personnel}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the roster and filter it | Owner, Admin |

Editors, Readers, Auditors and AI admins see **{{ui:admin.forbidden.title}}** instead of the page. An Admin whose membership carries a custom role can open it only if the custom role can both use the admin pages and view personnel. Custom roles built on Reader, Editor or Auditor had the permission to view personnel switched off when it became an Owner and Admin permission; an Owner or Admin can tick it again for a role on the {{ui:admin.roles.title}} page. The permission to manage personnel is for custom roles based on Admin only, and was switched off on every other custom role.

The page only reads. It has no button to add, change or remove a person.

## What it is for

The roster is what Inflect compares other records against. The identity features match the accounts in your directories to the people on it by work email, find accounts that still belong to people who have left, and check that joiners and leavers were handled on time. A person's status here is what makes them count as a leaver.

People reach the roster in two ways:

- **From your HR system.** Connect BambooHR, Workday or OrangeHRM on the [{{ui:admin.integrations.title}}](integrations.md) page. Inflect then reads the roster every night at 04:00 UTC, and whenever someone clicks **{{ui:admin.integrations.syncNow}}** on that connection.
- **By hand.** A person can be added through the Inflect API. This page cannot add one.

## What you see

**The header.** The page title and a line counting the people on the roster.

**The filter.** The **{{ui:common.ui.filter}}** button holds one filter, **{{ui:personnel.filters.status}}**, where you can choose one or more statuses. An active filter shows as a pill beside the button; remove the pill to drop it. The search box in the same menu, **{{ui:personnel.searchPlaceholder}}**, finds people by name or work email as you type. The filter and the search are kept in the page address, so a filtered view can be bookmarked, and both search the whole roster, not only the people on screen.

**The table.** One row per person, sorted by status, then by name. Rows cannot be opened.

| Column | What it shows |
| --- | --- |
| {{ui:personnel.colName}} | The person's full name, with their work email below it |
| {{ui:personnel.colStatus}} | Their employment status, such as {{ui:personnel.filterEnums.status.ACTIVE}} or {{ui:personnel.filterEnums.status.TERMINATED}} |
| {{ui:personnel.colDepartment}} | Their department, or a dash |
| {{ui:personnel.colTitle}} | Their job title, or a dash |
| {{ui:personnel.colSource}} | {{ui:personnel.sourceLabels.HRIS}} for a person read from your HR system, {{ui:personnel.sourceLabels.MANUAL}} for one added by hand |

The statuses mean:

| Status | Filter option | What it means |
| --- | --- | --- |
| ACTIVE | {{ui:personnel.filterEnums.status.ACTIVE}} | Currently employed |
| ONBOARDING | {{ui:personnel.filterEnums.status.ONBOARDING}} | Hired, with a start date still ahead |
| OFFBOARDING | {{ui:personnel.filterEnums.status.OFFBOARDING}} | Still employed, with a leaving date set |
| TERMINATED | {{ui:personnel.filterEnums.status.TERMINATED}} | Has left |
| LEAVE | {{ui:personnel.filterEnums.status.LEAVE}} | Employed and on leave |

The page shows at most 500 people at a time. In a larger roster a notice says so, and the count in the header is still the whole roster. Use the search or the status filter to reach anyone past the first 500.

## What you can do

- **Filter by status.** Open **{{ui:common.ui.filter}}**, choose **{{ui:personnel.filters.status}}** and tick the statuses you want, for example {{ui:personnel.filterEnums.status.TERMINATED}} to see everyone who has left.
- **Correct a person.** Change the record in your HR system. The next sync brings the change here.
- **Refresh the roster.** On the {{ui:admin.integrations.title}} page, click **{{ui:admin.integrations.syncNow}}** on the HR connection, then reload this page.

## What happens next

- Each nightly sync adds new people, updates the details of existing ones and sets each person's status from the HR system.
- When the HR system reports a new department or job title for someone, the change is recorded in the workspace's audit log, and Inflect can raise a task to re-examine their access. It never changes their access by itself.
- A person the HR system no longer reports, after a complete sync, is marked TERMINATED. If an unusually large share of the roster disappears at once, the sync marks none of them TERMINATED and leaves them for someone to look into. People added by hand are left alone.
- A person marked {{ui:personnel.filterEnums.status.TERMINATED}} becomes a leaver for the identity features, which can then flag, or disable, their accounts, depending on how the workspace has set those features up.
- The internal Personnel check, switched on with **{{ui:admin.integrations.enableInternal}}** on the {{ui:admin.integrations.title}} page, tests this roster: that leavers' access was removed, that joiners were onboarded on time and that every employee has a manager.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:admin.forbidden.title}}** | Your role cannot use the admin pages | Ask an Owner or Admin |
| **{{ui:personnel.emptyTitle}}**, with **{{ui:personnel.emptyDesc}}** | Nobody is on the roster | Connect your HR system on the {{ui:admin.integrations.title}} page. This page has no way to add a person |
| **{{ui:personnel.emptyMatchingTitle}}** | Nobody has the statuses you chose | Remove the filter |
| The roster shows fewer people than your HR system holds | The HR sync has not run since they were added | Click **{{ui:admin.integrations.syncNow}}** on the HR connection, then reload this page |
| A notice that not every person is shown | The roster holds more than 500 people | Search for the person, or filter by status |

## Related

- [{{ui:admin.integrations.title}}](integrations.md), where the HR connection is set up and synced.
- [{{ui:admin.members.title}}](members.md), for the people who can sign in to this workspace. The roster and the member list are separate: a person can be on one and not the other.
