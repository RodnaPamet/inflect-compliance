---
route: /t/[tenantSlug]/frameworks
---

# {{ui:frameworks.list.heading}}

The {{ui:frameworks.list.heading}} page lists every standard Inflect carries, such as ISO 27001 or NIS2. It shows how many requirements and control packs each one has, whether your workspace uses it, and how much of it your controls cover.

## Where to find it

Frameworks have no entry in the sidebar. Open the page from any of these:

- **{{ui:nav.audits}}** under **{{ui:nav.comply}}** in the sidebar opens the {{ui:audits.title}} page. In its header, beside **{{ui:audits.hub.related}}**, click **{{ui:audits.nav.frameworks}}**.
- Click **{{ui:common.search}}** in the sidebar, or press Ctrl+K (⌘K on a Mac), and choose **Go to Frameworks**.
- While the workspace has no controls, the {{ui:controls.list.pageTitle}} page offers **{{ui:controls.empty.installFramework}}**, which opens this page.

A back link above the title returns you to the page you came from, or to {{ui:audits.title}}.

## Who can use it

| Action | Roles |
| --- | --- |
| View the page, and open any framework to read its requirements, packs and coverage | Every role: Owner, Admin, Editor, Reader, Auditor and AI admin |
| Click **{{ui:frameworks.list.importFramework}}** to add a framework | Owner, Admin |

**{{ui:frameworks.list.importFramework}}** appears only for roles that can add frameworks.

If your workspace uses custom roles, viewing the page needs permission to view frameworks, and **{{ui:frameworks.list.importFramework}}** needs permission to install them, whatever the custom role's base role. A custom role without view permission gets an error page in place of the list.

## What it is for

Use the page to choose the standards your organisation works to and to track how far each one is covered. Adding a framework installs its control pack: the controls, starter tasks and requirement mappings that make it count. From here you open a framework to read its requirements and see which of them still lack a control.

## What you see

**The header.** The page title and its description. On the right:

- **{{ui:common.ui.viewTable}}** and **{{ui:common.ui.viewCards}}** switch between a table and cards. The page starts on cards and remembers your choice.
- In the table view only, **{{ui:common.table.toggleColumns}}** chooses which columns are shown.
- **{{ui:frameworks.list.importFramework}}**, for roles that can add frameworks.

**The cards.** One card per framework, in order of the framework's short code. Click anywhere on a card to open the framework. Each card shows:

- The framework's name and, under it, its kind, such as **{{ui:frameworks.kinds.isoStandard}}** or **{{ui:frameworks.kinds.euDirective}}**.
- Its status: **{{ui:frameworks.list.installed}}** or **{{ui:frameworks.list.available}}**. Hold the pointer over **{{ui:frameworks.list.installed}}** to read **{{ui:frameworks.list.inUseHint}}**.
- **{{ui:frameworks.list.requirements}}**, **{{ui:frameworks.list.packs}}** and **{{ui:frameworks.list.coverage}}**, then a short description and a coverage bar.
- For a standard published by another body, a line naming its source and licence. **{{ui:frameworks.list.referenceIndexNote}}** on that line means Inflect holds the requirement codes and links to the standard's own text.

**The table.** The same frameworks, one row each, under **{{ui:frameworks.list.framework}}**, **{{ui:frameworks.list.domain}}**, **{{ui:frameworks.list.requirements}}**, **{{ui:frameworks.list.coverage}}** and **{{ui:frameworks.list.status}}**. Click a name to open the framework. The columns cannot be sorted.

**What the figures mean.**

- **{{ui:frameworks.list.coverage}}** is the share of the framework's requirements that have at least one of your controls mapped to them. Deleted controls do not count. A requirement the standard has dropped is left out.
- When a framework has several packs, coverage counts only the requirements of the packs your workspace chose, as [Add a framework](../../how-to/get-started/add-a-framework.md) explains.
- **{{ui:frameworks.list.installed}}** means at least one of the requirements coverage counts has a mapped control. Coverage is rounded to a whole percent, except that a framework with any mapped requirement never reads 0%: a large framework with only a few mapped requirements reads <1%. Neither figure says whether the controls work; evidence and tests show that.
- **{{ui:frameworks.list.requirements}}** is the number of requirements coverage is worked out from: the current requirements of the packs your workspace chose. It is the figure the framework's **{{ui:frameworks.detail.coverageTab}}** tab gives as its total. When coverage cannot be worked out, it shows every requirement Inflect holds for the framework instead.

Frameworks Inflect no longer offers are not listed. A workspace that installed one keeps its controls and mappings.

## What you can do

### Open a framework

Click its name, or its card. The framework's own page has four tabs: **{{ui:frameworks.detail.reqTab}}**, the requirements and the controls mapped to each; **{{ui:frameworks.detail.packsTab}}**, the packs you can install or remove; **{{ui:frameworks.detail.coverageTab}}**, the mapped and unmapped requirements; and **{{ui:frameworks.detail.builderTab}}**, where roles that can add frameworks reorder the requirements for this workspace.

### Add a framework

Click **{{ui:frameworks.list.importFramework}}**. It opens the install page for the first framework your workspace does not use yet, which may not be the one you want, so check the name at the top. To install a particular framework, open it and click **{{ui:frameworks.detail.installPack}}** there. [Add a framework](../../how-to/get-started/add-a-framework.md) walks through the install, the packs and removing a pack.

## What happens next

- The page itself changes nothing. A framework's status and coverage change when you install its pack, or map a control to one of its requirements on the control's page.
- Coverage is worked out each time the page loads, so it reflects your controls as they stand.
- A framework that reads **{{ui:frameworks.list.installed}}** is offered when you set up an audit cycle. See [Set up an audit cycle](../../how-to/audits/set-up-an-audit-cycle.md).

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:frameworks.list.empty}}** | No frameworks are loaded into this installation of Inflect | Ask whoever runs your Inflect installation to load them |
| A dash in place of a framework's coverage and status, with the hint **{{ui:frameworks.list.coverageError}}** | Inflect could not work out that framework's coverage this time, so it cannot say whether the framework is in use | Reload the page |
| No **{{ui:frameworks.list.importFramework}}** button | Your role cannot add frameworks | Ask an Owner or Admin |
| **{{ui:common.error.title}}** | The page could not load, or your custom role cannot view frameworks | Click **{{ui:common.error.tryAgain}}**. If it persists, ask an Owner or Admin about your role |

## Related

- [Add a framework](../../how-to/get-started/add-a-framework.md), step by step, including the setup wizard.
- [{{ui:controls.list.pageTitle}}](controls.md), for the controls a framework's coverage counts.
- [{{ui:audits.title}}](../comply/audits.md), where audits are run against a framework.
- [Set up an audit cycle](../../how-to/audits/set-up-an-audit-cycle.md), which offers only the frameworks your workspace uses.
