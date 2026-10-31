---
route: /t/[tenantSlug]/controls/templates
---

# {{ui:controls.templates.title}}

The {{ui:controls.templates.title}} page lists the ready-made controls in the library and installs the ones you pick into your register, each with its tasks and its links to framework requirements.

## Where to find it

Open **{{ui:nav.controls}}** under **{{ui:nav.govern}}** in the sidebar, open **{{ui:common.ui.viewsMenu}}** in the toolbar and choose **{{ui:controls.list.installTemplates}}**. The menu item is offered only to roles that can create controls. The back link returns you to the page you came from.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page and browse the templates | Every role: Owner, Admin, Editor, Reader, Auditor and AI admin |
| Install templates | Owner, Admin, Editor |

The tick boxes and the install bar appear only for Owners, Admins and Editors. Other roles see the list without them.

If your workspace uses custom roles, installing also needs permission to create controls; without it, the page offers no tick boxes and no install bar.

In a workspace on a plan with a control limit, an install that would take the register past the limit is refused as a whole, before any control is created.

## What it is for

Use templates to start a register quickly, or to add a well-known control without writing it from scratch. A template brings its tasks and its requirement mappings with it.

## What you see

**The install bar.** For roles that can install, an install button that counts the templates you have ticked. It stays disabled until you tick one.

**The search box.** **{{ui:controls.templates.searchPlaceholder}}** narrows the list as you type, matching a template's code, name or category.

**The list.**

| Column | What it shows |
| --- | --- |
| (tick box) | Whether the template is selected. The box in the heading, **{{ui:controls.templates.selectAll}}**, selects or clears every template the search shows |
| {{ui:controls.templates.colCode}} | The template's code. An installed control keeps it |
| {{ui:controls.templates.colName}} | The template's name |
| {{ui:controls.templates.colCategory}} | Its category, if it has one |
| {{ui:controls.templates.colPreview}} | How many tasks it creates and how many requirement links it adds |
| {{ui:controls.templates.colDescription}} | The start of its description |

Clicking anywhere on a row ticks or clears it.

## What you can do

### Install templates

1. Tick the templates you want, or search and tick the box in the heading to select every match. A selection survives a change of search.
2. Click the install button. While it works the button reads **{{ui:controls.templates.installing}}**.

For each template, a new control is created with the template's code, name and description, its tasks, its requirement links, and links to any of your policies whose titles the template names. A template whose code is already used by a control in your register is skipped, and that control is left as it is.

A green notice reports how many controls were installed, and how many were skipped because they already exist. If a selected template no longer exists in the library, a separate notice says so; nothing is installed for it. A moment later the page opens the {{ui:controls.list.pageTitle}} list.

## What happens next

The new controls start at their template's defaults, with no owner. Their tasks appear on the {{ui:tasks.list.srTitle}} page, and their requirement links count towards framework coverage straight away. Each installed control is recorded in the audit log.

## Empty and error states

| What you see | Why | What to do |
| --- | --- | --- |
| **{{ui:controls.templates.emptyTitle}}** | The library holds no templates | Ask your admin about the template library |
| **{{ui:controls.templates.noMatchTitle}}** | Nothing matches your search | Click **{{ui:controls.templates.clearSearch}}**, or search for another code, name or category |
| **{{ui:controls.templates.loadFailed}}** with **{{ui:controls.templates.retry}}** | The templates could not be read | Click **{{ui:controls.templates.retry}}** |
| A red notice after installing | The install was refused or failed. The notice gives the reason when there is one | Check your role, then try again |
| A notice that the plan allows a number of controls | The install would take the register past the plan's control limit | Install fewer templates, or upgrade the plan |
| The notice says everything was skipped | Every selected template's code is already in your register | Nothing to do: those controls already exist |

## Related

- [{{ui:controls.list.pageTitle}}](controls.md), where installed controls appear.
- [Add a framework](../../how-to/get-started/add-a-framework.md), which installs a whole framework's controls at once.
- [{{ui:controls.dashboard.title}}](controls-dashboard.md), for the register's figures after an install.
