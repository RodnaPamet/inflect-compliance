---
route: /t/[tenantSlug]/frameworks/[frameworkKey]/templates
---

# Framework template library

A framework's template library lists every ready-made control the framework offers, one template at a time. You can read each template's tasks and requirements, and install only the templates you want instead of a whole pack.

## Where to find it

On a framework's page, click **{{ui:frameworks.detail.browseTemplates}}** in the header. The page has a back link and no breadcrumb.

## Who can use it

| Action | Roles |
| --- | --- |
| Browse the templates | Everyone who can see frameworks |
| Install templates | Owner, Admin |

If your workspace uses custom roles, installing needs permission to install frameworks. Without it the page shows no install controls.

## What it is for

Pick the controls you need when a whole pack would be too much, or add a control you left out when you installed the pack.

## What you see

The heading names the framework, with how many templates there are, how many you have **{{ui:frameworks.templates.installed}}** and how many are **{{ui:frameworks.templates.available}}**.

**Filters.** A search box, **{{ui:frameworks.templates.searchPlaceholder}}**, filters by code or title as you type. **{{ui:frameworks.templates.allCategories}}** and **{{ui:frameworks.templates.allSections}}** narrow the list to one control category or one requirement section. If you can install, **{{ui:frameworks.templates.selectAllUninstalled}}** sits beside them, and selects the templates the filters show.

**The templates.** One card per template, with its code and title, **{{ui:frameworks.templates.installed}}** or **{{ui:frameworks.templates.available}}**, its category and how often the control should run, and how many tasks and requirements it brings. Click a template's title to open it:

- its description;
- **{{ui:frameworks.templates.mappedRequirements}}**, each with the framework it belongs to;
- **{{ui:frameworks.templates.defaultTasks}}**, the tasks created with the control;
- **{{ui:frameworks.templates.suggestedEvidence}}**, when the template's tasks name the proof they produce.

A template is installed once your workspace has a control with its code.

## What you can do

### Install one template

Click **{{ui:frameworks.templates.install}}** on its card. The control is created with its tasks and its requirement mappings, and the card changes to **{{ui:frameworks.templates.installed}}**.

### Install several

Tick the templates you want, or click **{{ui:frameworks.templates.selectAllUninstalled}}**, and click the install button at the top, which names how many you selected.

### Filter the list

Type part of a template's code or title, or choose a category or a section. Each list always offers every category and section in the library, so you can move straight from one to another. The counts under the heading follow the filters.

## What happens next

- An installed template becomes an ordinary control, with the status **{{ui:controls.statusLabels.NOT_STARTED}}**. Work on it on the [{{ui:controls.list.pageTitle}}](controls.md) page.
- Installing a template whose control you already have changes nothing.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:frameworks.templates.emptyFilter}}** | No template matches the search and filters | Clear the search, and choose **{{ui:frameworks.templates.allCategories}}** and **{{ui:frameworks.templates.allSections}}** |
| **{{ui:frameworks.templates.loadFailed}}** | The templates could not load | Click **{{ui:frameworks.templates.retry}}** |
| **{{ui:frameworks.templates.installRestricted}}** | Your role cannot install templates | Ask an Owner or Admin |
| **{{ui:frameworks.templates.installFailed}}**, or another reason the install was refused | Some or none of the templates were installed | Reload the page to see what was added, then try again |

## Related

- [A framework](framework-detail.md), the framework's requirements and packs.
- [Install a framework pack](framework-install.md), to install a whole pack at once.
