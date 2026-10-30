---
route: /t/[tenantSlug]/calendar
---

# {{ui:calendar.title}}

The {{ui:calendar.title}} puts every dated obligation in the workspace on one calendar: evidence and policy reviews, vendor renewals, audit cycles and scheduled audits, control reviews and tests, task due dates, risk reviews, findings, asset vulnerability fix dates and more. It answers "what is due, and when".

## Where to find it

Open **{{ui:nav.calendar}}** under **{{ui:nav.comply}}** in the sidebar. The breadcrumb reads **{{ui:calendar.crumbDashboard}}** › **{{ui:calendar.crumbCalendar}}**.

The sidebar entry can carry a number. It counts only your own open tasks that have a due date, late or not, and none of the calendar's other deadlines. A small number there does not mean the workspace has little due.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page and see the deadlines | Every role: Owner, Admin, Editor, Reader, Auditor and AI admin. Each sees only the kinds of deadline their role can read |
| Create a task on a day | Owner, Admin, Editor |
| Complete or reschedule a task from the day's list | Owner, Admin, Editor |

The calendar collects deadlines from many registers, and each kind follows the rule of the register it comes from. Two kinds are left out for most roles:

- **{{ui:calendar.source.training}}** due dates are shown only to Owners and Admins.
- **{{ui:calendar.source.agent-harness-acceptance}}** expiry dates are shown to Owners, Admins and AI admins.

When a kind is left out, a grey note above the calendar names it, so a missing kind is never mistaken for one with nothing due. If your workspace uses custom roles, each kind follows your custom role's own permissions for its register.

## What it is for

Use the calendar to plan the weeks ahead and to catch what is late. Every entry links to the record it comes from, so you can go straight to the review, renewal or task and deal with it.

## What you see

**The header.** The description, and three buttons that switch the view: **{{ui:calendar.viewMonth}}**, **{{ui:calendar.viewHeatmap}}** and **{{ui:calendar.viewTimeline}}**. The page opens on **{{ui:calendar.viewMonth}}**.

**The range bar.** In **{{ui:calendar.viewMonth}}**, it names the month, with arrows to the previous and next month. The other two views cover a fixed window, and the bar says which:

| View | Window |
| --- | --- |
| {{ui:calendar.viewMonth}} | One month, padded with the days that complete its first and last weeks |
| {{ui:calendar.viewHeatmap}} | {{ui:calendar.heatmapWindowLabel}} |
| {{ui:calendar.viewTimeline}} | {{ui:calendar.ganttWindowLabel}}: six months back and six months ahead |

**The calendar itself.**

- **{{ui:calendar.viewMonth}}** is a grid of weeks. Each day shows up to three entries as coloured dots with their titles, and a **+** count for the rest. Today's day is ringed. Click an entry to open its record, or click the day, or its count, to list everything on it in the side panel.
- **{{ui:calendar.viewHeatmap}}** shows one square per day, darker the more is due that day, with month separators. Click a day to list its entries in the side panel.
- **{{ui:calendar.viewTimeline}}** shows one row per entry along a time axis, with a line for today. An audit cycle is drawn as a bar from its start to its end, and every other entry as a one-day mark. Click a row to open its record. This view has no days to click, so the side panel says **{{ui:calendar.clickDayTimeline}}**

Each entry has a category, shown by its colour, and a status:

| Status | Meaning |
| --- | --- |
| {{ui:calendar.status.overdue}} | The date has passed and the obligation is still open |
| {{ui:calendar.status.due_soon}} | Due within the next seven days |
| {{ui:calendar.status.scheduled}} | Due later |
| {{ui:calendar.status.done}} | Already met, for example a closed task |

Statuses are judged against one day that is the same for everyone, so "today" is the same day in all three views, wherever you are.

**The side panel.** Beside the calendar, or above it on a narrow screen:

- **{{ui:calendar.filterAria}}.** One tick box per category: {{ui:calendar.category.evidence}}, {{ui:calendar.category.policy}}, {{ui:calendar.category.vendor}}, {{ui:calendar.category.audit}}, {{ui:calendar.category.control}}, {{ui:calendar.category.task}}, {{ui:calendar.category.risk}} and {{ui:calendar.category.finding}}, each with its colour. With none ticked, every category is shown. **{{ui:calendar.filterClear}}** unticks them all.
- **{{ui:calendar.myDeadlines}}.** Shows only the entries whose owner is you.
- A count of the entries shown, which follows the filter.
- The chosen day's entries. Until you choose a day, the panel reads **{{ui:calendar.clickDay}}** Each entry shows its title, any detail, its category and its status, and links to its record.

The view, the month and the filter are kept in the page's address, so a link you copy opens the same view for whoever you send it to.

## What you can do

### Find what is due

Choose a view, move between months in **{{ui:calendar.viewMonth}}**, and tick categories to narrow the calendar. Tick **{{ui:calendar.myDeadlines}}** to see only what you own. Some kinds of entry have no owner, so they cannot be filtered that way; while **{{ui:calendar.myDeadlines}}** is ticked, a note names the kinds it hides.

### Create a task on a day

In **{{ui:calendar.viewMonth}}**, click the **+** on a day, or double-click the day. Or choose a day and click **{{ui:calendar.newTaskOnDay}}** in the side panel. The new-task form opens with that day as the due date. It is the same form as on the [{{ui:tasks.list.srTitle}}](tasks.md) page. The task appears on the calendar once it is created.

### Complete or reschedule a task

Choose the day, and find the task in the side panel. Under it:

- **{{ui:calendar.completeAction}}** closes the task, with the resolution "{{ui:calendar.taskCompleteResolution}}". It is not offered for a task that is already done. The message **{{ui:calendar.taskCompleted}}** confirms it.
- **{{ui:calendar.rescheduleAction}}** opens a date picker. Choose the new due date, and the message **{{ui:calendar.taskRescheduled}}** confirms it. **{{ui:calendar.rescheduleCancel}}** closes the picker without a change.

A task that has a reviewer cannot be closed this way unless it is in review and you are its reviewer. Open the task and follow its review steps instead. See [{{ui:tasks.list.srTitle}}](tasks.md).

Other entries, such as a policy review or a vendor renewal, cannot be changed from the calendar. Open the record and change it there.

### Jump to the next deadline

When nothing is due in the range you are looking at, a bar names the date of the next deadline within the coming two years, with **{{ui:calendar.offscreenJump}}**. Click it to open that month in **{{ui:calendar.viewMonth}}** and select the day.

The date is the next deadline that passes the filter. The jump keeps the filter and **{{ui:calendar.myDeadlines}}** as they are, and always switches to **{{ui:calendar.viewMonth}}**, where the chosen day is shown.

## What happens next

- An entry moves on the calendar when its record changes: a review completed, a due date moved, a task closed.
- Completing or rescheduling a task here is the same change as making it on the task itself, and it is recorded in the workspace's audit log, naming you.
- A task created here appears in {{ui:nav.tasks}}.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:calendar.loading}}** | The deadlines for the new range are loading | Wait a moment |
| **{{ui:calendar.loadError}}** | The calendar could not load | Refresh the page |
| A yellow note that some sources could not be loaded, naming them | Those kinds of deadline failed to load and are missing from the view. The rest are shown | Refresh the page to try again |
| A grey note that some sources are hidden by your permissions, naming them | Your role cannot read those kinds of deadline | Nothing, unless you need them; then ask an Owner or Admin |
| A yellow note that only the nearest deadlines are shown for some sources | One kind has more deadlines in the range than the calendar shows at once, so the furthest are left out | Look at a shorter range, such as a single month |
| **{{ui:calendar.eventsEmptyDay}}** | The chosen day has nothing due, or nothing that passes your filter | Choose another day, or clear the filter |
| **{{ui:calendar.ganttEmpty}}** | Nothing is due in the timeline's window, or nothing that passes your filter | Clear the filter, or use **{{ui:calendar.viewMonth}}** to look further ahead |
| The reason the task could not be changed, such as that it needs its reviewer's sign-off | The task was not changed | Follow the reason given; for a task with a reviewer, open the task and use its review steps |
| **{{ui:calendar.taskForbidden}}** or **{{ui:calendar.taskActionError}}** | The task was not changed, and no reason was given | Open the task and make the change there |

## Related

- [{{ui:tasks.list.srTitle}}](tasks.md), where tasks are worked.
- [{{ui:audits.title}}](audits.md), whose cycles appear on the calendar.
- [{{ui:evidence.title}}](evidence.md), [{{ui:policies.title}}](../manage/policies.md) and [{{ui:vendors.title}}](../manage/vendors.md), the registers with the most review dates.
