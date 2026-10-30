---
route: /t/[tenantSlug]/risks/information-registry
---

# {{ui:risks.informationRegistry.title}}

The {{ui:risks.informationRegistry.title}} is the workspace's register of information under the EU's Digital Operational Resilience Act (DORA): every contractual arrangement with an ICT third-party service provider, with the ones that support a critical or important function flagged. It is built from your vendors; there is nothing to enter on the page itself.

## Where to find it

Open **{{ui:nav.risks}}** under **{{ui:nav.govern}}** in the sidebar, then choose **{{ui:risks.viewLinks.informationRegistry}}** under **{{ui:risks.viewsRegistry}}** in the **{{ui:risks.viewsMenu}}** menu. The page's back link returns you to the risks page.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the register | Every role: Owner, Admin, Editor, Reader, Auditor and AI admin |
| Change what it shows | Nobody here. Change the vendor instead, which Owners, Admins and Editors can do; see [{{ui:vendors.title}}](../manage/vendors.md) |

If your workspace uses custom roles, the register follows your custom role's own permission to read vendors.

## What it is for

DORA Article 28(3) requires financial entities to keep a register of all their contracts for ICT services and to say which support critical or important functions. Use this page as that register, or as the starting point for the version you file with your supervisor.

## What you see

**The header.** The title, with an information icon explaining the requirement. Under it, the legal basis, a count of the arrangements and of how many support a critical or important function, and a note saying what the register is built from and which DORA fields Inflect does not hold, such as LEI codes and contract values.

**The filter.** **{{ui:risks.informationRegistry.searchPlaceholder}}** searches the providers' names, legal names and countries. The filter offers **{{ui:risks.informationRegistry.colCriticality}}** and **{{ui:risks.informationRegistry.colStatus}}**, with their options as codes: CRITICAL, HIGH, MEDIUM, LOW; and ACTIVE, ONBOARDING, OFFBOARDED and SUSPENDED. No vendor has the status SUSPENDED, and a vendor that is being offboarded cannot be filtered for.

**The register.** One row per vendor, most critical first:

| Column | What it shows |
| --- | --- |
| {{ui:risks.informationRegistry.colProvider}} | The vendor's name, with its legal name under it. The legal name is the one a supervisor matches against |
| {{ui:risks.informationRegistry.colFunction}} | **{{ui:risks.informationRegistry.functionYes}}** when the vendor's criticality is Critical or High, otherwise **{{ui:risks.informationRegistry.functionNo}}** |
| {{ui:risks.informationRegistry.colCriticality}} | The vendor's criticality, as a code |
| {{ui:risks.informationRegistry.colCountry}} | The vendor's country |
| {{ui:risks.informationRegistry.colDataAccess}} | How much of your data the vendor can reach, as a code |
| {{ui:risks.informationRegistry.colContractEnd}} | When the contract is up for renewal |
| {{ui:risks.informationRegistry.colStatus}} | The vendor's status, as a code |
| {{ui:risks.informationRegistry.colOwner}} | The person responsible for the vendor |

A field the vendor has no value for reads **{{ui:risks.informationRegistry.notRecorded}}**. Click a row to open the vendor.

## What you can do

### Keep the register complete

The register shows every vendor in the workspace that has not been deleted, up to 1,000. To add an arrangement, add the vendor; to correct a row, edit the vendor. Fill in each vendor's legal name, country, data access, contract renewal date and owner, so its row has no **{{ui:risks.informationRegistry.notRecorded}}** gaps. Set the criticality to Critical or High for every vendor that supports a critical or important function.

## What happens next

- A change to a vendor shows in the register the next time the page opens.
- A deleted vendor leaves the register.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:risks.informationRegistry.empty}}** | The workspace has no vendors | {{ui:risks.informationRegistry.emptyDesc}} |
| **{{ui:risks.informationRegistry.emptyFilteredTitle}}** | No vendor matches the filter or search | {{ui:risks.informationRegistry.emptyFilteredDesc}} |

## Related

- [{{ui:vendors.title}}](../manage/vendors.md), where the register's rows come from.
- [{{ui:risks.title}}](risks.md), where this register is reached from.
