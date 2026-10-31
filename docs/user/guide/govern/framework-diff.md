---
route: /t/[tenantSlug]/frameworks/[frameworkKey]/diff
---

# {{ui:frameworks.diff.heading}}

The {{ui:frameworks.diff.heading}} page compares the requirements of two frameworks, typically two versions of the same standard, and shows which requirements were added, removed or changed between them.

## Where to find it

On a framework's page, click **{{ui:frameworks.detail.compareRequirements}}**. The framework you are on is the newer one. Choose the one to compare it against under **{{ui:frameworks.diff.compareFrom}}**: {{ui:frameworks.diff.chooseHint}}

The address then names both frameworks, so you can send it to a colleague.

## Who can use it

Everyone who can see frameworks. The page changes nothing.

## What it is for

Plan a move to a new version of a standard: see which requirements are new and still need a control, which have gone, and which were reworded or moved.

## What you see

**{{ui:frameworks.diff.heading}}**, and under it **{{ui:frameworks.diff.comparing}}** with the two frameworks' names and, when they have one, their versions. Below it, **{{ui:frameworks.diff.compareFrom}}** lists every other framework in the catalogue by name; choose another at any time.

Four figures:

| Figure | Counts |
| --- | --- |
| **{{ui:frameworks.diff.added}}** | Requirements in the newer framework that the older one does not have |
| **{{ui:frameworks.diff.removed}}** | Requirements in the older framework that the newer one does not have |
| **{{ui:frameworks.diff.changed}}** | Requirements in both, whose title, section or description differs |
| **{{ui:frameworks.diff.newUnmapped}}** | Added requirements that no control of yours is mapped to |

Then three tabs, **{{ui:frameworks.diff.added}}**, **{{ui:frameworks.diff.removed}}** and **{{ui:frameworks.diff.changed}}**, each with its count. Requirements are matched by their code.

- An added requirement shows its code, title and section.
- A removed one shows the same, struck through.
- A changed one lists what changed, and the old and new title or section side by side. A changed description is shown in full, **{{ui:frameworks.diff.before}}** and **{{ui:frameworks.diff.after}}**.

## What you can do

### Find the requirements to map

Open **{{ui:frameworks.diff.added}}**. Each one with no mapped control counts in **{{ui:frameworks.diff.newUnmapped}}**. Map a control to it on the framework's page, or on the control's page.

### Check what was reworded

Open **{{ui:frameworks.diff.changed}}** and read each old and new title. A control mapped to a reworded requirement may need its description updated.

## What happens next

- The page reads both frameworks as they are when it opens. Deprecated requirements are left out of both.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| {{ui:frameworks.diff.chooseHint}} | No framework to compare from is chosen yet | Choose one under **{{ui:frameworks.diff.compareFrom}}** |
| **{{ui:frameworks.diff.refused.DIFF_FROM_NOT_FOUND}}** | The address names a framework the catalogue no longer has | Choose another |
| **{{ui:frameworks.diff.computeFailed}}** | The comparison failed | Click **{{ui:frameworks.diff.retry}}** |
| **{{ui:frameworks.diff.loadDataFailed}}** | The page could not reach the server | Click **{{ui:frameworks.diff.retry}}** |
| **{{ui:frameworks.diff.frameworksFailed}}** | The list of frameworks to choose from could not load | Reload the page |
| **{{ui:frameworks.diff.emptyAdded}}**, **{{ui:frameworks.diff.emptyRemoved}}** or **{{ui:frameworks.diff.emptyChanged}}** | Nothing of that kind differs | Nothing to do |

## Related

- [A framework](framework-detail.md).
- [{{ui:frameworks.list.heading}}](frameworks.md).
