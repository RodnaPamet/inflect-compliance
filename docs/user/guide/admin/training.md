---
route: /t/[tenantSlug]/admin/training
---

# {{ui:training.title}}

The {{ui:training.title}} page lists the security-awareness training assigned to people in this workspace: who, which course, by when, and whether they have finished it. It is a read-only list.

## Where to find it

Click **{{ui:nav.admin}}** at the bottom of the sidebar. Under {{ui:admin.section.people}}, click **{{ui:admin.nav.training}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page | Owner, Admin |

Editors, Readers, Auditors and AI admins see **{{ui:admin.forbidden.title}}**. An Admin whose membership carries a custom role can open the page only if that role can view personnel.

## What it is for

Security-awareness training is a control in most frameworks, and auditors ask for evidence that people completed it. Each row here is one assignment: one course given to one employee, with a due date. The same records feed Inflect's training checks, which can test that control automatically.

## What you see

Under the title, a line counts the assignments. Then a table:

| Column | What it shows |
| --- | --- |
| {{ui:training.colEmployee}} | The employee's name, with their work email below it |
| {{ui:training.colCourse}} | The course assigned |
| {{ui:training.colStatus}} | Where the assignment stands: **{{ui:training.filterEnums.status.ASSIGNED}}**, **{{ui:training.filterEnums.status.IN_PROGRESS}}**, **{{ui:training.filterEnums.status.COMPLETED}}** or **{{ui:training.filterEnums.status.OVERDUE}}**. An assignment that is not completed reads Overdue once its due date has passed |
| {{ui:training.colDue}} | When it is due, or — when no date was set |
| {{ui:training.colCompleted}} | When it was completed, or — |

The table is grouped by status, with the most recently assigned first within each.

The page shows at most 500 assignments at a time. When there are more, a notice says so. Use the search or the status filter to reach any assignment past the first 500.

## What you can do

**Search.** Open the filter and type in the search box at the top. The list narrows to assignments whose employee, email or course contains what you type.

**Filter by status.** In the same filter, choose **{{ui:training.filters.status}}**: {{ui:training.filterEnums.status.ASSIGNED}}, {{ui:training.filterEnums.status.IN_PROGRESS}}, {{ui:training.filterEnums.status.COMPLETED}} or {{ui:training.filterEnums.status.OVERDUE}}. You can choose more than one. Overdue finds every open assignment past its due date.

Nothing on this page creates a course, assigns one or records a completion.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:admin.forbidden.title}}** | Your role cannot use the admin pages | Ask an Owner or Admin |
| **{{ui:training.emptyTitle}}** | No training has been assigned in this workspace. {{ui:training.emptyDesc}} | Ask whoever assigns your training to do it through Inflect's API |
| **{{ui:training.emptyMatchingTitle}}** | No assignment matches the search or the status filter | Clear the search or the filter |
| A notice that not every assignment is shown | There are more than 500 assignments | Search for the assignment, or filter by status |

## Related

- [{{ui:admin.nav.personnel}}](personnel.md), the employees training is assigned to.
- [{{ui:admin.nav.devices}}](devices.md), the other people-posture list.
