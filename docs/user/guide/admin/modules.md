---
route: /t/[tenantSlug]/admin/modules
---

# {{ui:admin.modules.heading}}

The {{ui:admin.modules.heading}} page turns optional parts of the product on or off for this workspace. Today there is one optional module, the process canvas.

## Where to find it

Click **{{ui:nav.admin}}** at the bottom of the sidebar. Under {{ui:admin.section.organization}}, click **{{ui:admin.nav.modules}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page and turn a module on or off | Owner |

Admins see a page saying **{{ui:admin.modules.forbidden}}** Editors, Readers, Auditors and AI admins see **{{ui:admin.forbidden.title}}**.

## What it is for

{{ui:admin.modules.intro}}

## What you see

One card per module, with its name, an **{{ui:admin.modules.on}}** or **{{ui:admin.modules.off}}** badge, a description and a **{{ui:admin.modules.turnOn}}** or **{{ui:admin.modules.turnOff}}** button.

**{{ui:admin.modules.processCanvas.name}}.** {{ui:admin.modules.processCanvas.description}} It is off until an Owner turns it on. Its card always carries a notice, **{{ui:admin.modules.processCanvas.licenceHeading}}**, about the licence of the diagram editor the canvas uses.

## What you can do

Click **{{ui:admin.modules.turnOn}}** or **{{ui:admin.modules.turnOff}}**. The change is saved at once and applies to everyone in the workspace.

- **On.** **{{ui:nav.processes}}** appears under **{{ui:nav.manage}}** in the sidebar, for everyone in the workspace.
- **Off.** The sidebar entry goes, and the process page reports that it was not found. Nothing is deleted: the processes, their steps and the controls placed on them are kept, and reappear unchanged when the module is turned back on.

If the change fails, **{{ui:admin.modules.saveFailedHeading}}** appears and the module stays as it was.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:admin.modules.forbidden}}** | You are not an Owner | Ask an Owner |
| **{{ui:admin.modules.loadFailed}}** | The module settings did not load | Reload the page |
| **{{ui:admin.modules.saveFailedHeading}}** | The change did not save | Try again; do not assume it applied |

## Related

- [{{ui:admin.nav.aiFeatures}}](ai-features.md), the other switches for what the workspace has.
- [{{ui:nav.processes}}](../manage/processes.md), the pages this module shows and hides.
