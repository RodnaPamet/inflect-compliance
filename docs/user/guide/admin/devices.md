---
route: /t/[tenantSlug]/admin/devices
---

# {{ui:devices.title}}

The {{ui:devices.title}} page lists the computers people in this workspace use, and whether each meets four basic security checks: disk encryption, screen lock, antivirus and a password manager. It is a read-only inventory.

## Where to find it

Click **{{ui:nav.admin}}** at the bottom of the sidebar. Under {{ui:admin.section.people}}, click **{{ui:admin.nav.devices}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page | Owner, Admin |

Editors, Readers, Auditors and AI admins see **{{ui:admin.forbidden.title}}**. An Admin whose membership carries a custom role can open the page only if that role can view personnel.

## What it is for

Device posture is evidence for several controls: that laptops are encrypted, lock themselves, run antivirus and have a password manager. Each device is reported to Inflect by a small reporter program that runs on it. The program sends the device's name, serial number, operating system and the four checks, and updates them each time it reports.

The same records feed Inflect's device posture checks, which can test those controls automatically.

## What you see

Under the title, a line counts the devices in the inventory. Then a table:

| Column | What it shows |
| --- | --- |
| {{ui:devices.colDevice}} | The device's name, or its serial number when it reported no name. Below it, its operating system and how it was added |
| {{ui:devices.colEncrypted}} | Whether the disk is encrypted |
| {{ui:devices.colScreenLock}} | Whether the screen locks |
| {{ui:devices.colAntivirus}} | Whether antivirus is running |
| {{ui:devices.colPwManager}} | Whether a password manager is installed |

Each check reads **{{ui:devices.yes}}**, **{{ui:devices.no}}**, or **{{ui:devices.naShort}}** when the device did not report it. The table shows up to 500 devices, sorted by operating system and then name.

## What you can do

**Filter by platform.** Open the filter and choose **{{ui:devices.filters.platform}}**: {{ui:devices.filterEnums.platform.MACOS}}, {{ui:devices.filterEnums.platform.WINDOWS}} or {{ui:devices.filterEnums.platform.LINUX}}. You can choose more than one.

Nothing on this page adds, edits or removes a device.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:admin.forbidden.title}}** | Your role cannot use the admin pages | Ask an Owner or Admin |
| **{{ui:devices.emptyTitle}}** | No device has reported to this workspace | Ask whoever runs your device reporting to connect it to this workspace |
| **{{ui:devices.emptyMatchingTitle}}** | No device matches the platform filter | Clear the filter |

## Related

- [{{ui:admin.nav.personnel}}](personnel.md), the people these devices belong to.
- [{{ui:admin.nav.training}}](training.md), the other people-posture list.
