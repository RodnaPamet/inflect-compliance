---
route: /t/[tenantSlug]/mapping
---

# {{ui:mapping.title}}

The {{ui:mapping.title}} page estimates how far your ISO 27001 controls go towards SOC 2 and NIS2, through a fixed table that relates ISO 27001 controls to the other two frameworks. {{ui:mapping.subtitle}}

## Where to find it

No menu or button leads to the page: it opens from a link to it. The breadcrumb reads **{{ui:mapping.crumbDashboard}}** › **{{ui:mapping.title}}**.

## Who can use it

Every role. The page only reads.

## What it is for

Get a rough idea of how much of SOC 2 or NIS2 your ISO 27001 work already covers, before you install either framework. Once a framework is installed, its own page, where your controls are mapped to its requirements directly, is the measure to trust.

## What you see

A switch between **{{ui:mapping.soc2}}** and **{{ui:mapping.nis2}}**. Then one card per SOC 2 criterion or NIS2 area, with:

- its code, title and a short description;
- the share of the related controls that are implemented, as a percentage and a bar;
- how many related controls are implemented, out of how many.

A control counts as related when it is one of your ISO 27001 controls and the table relates its ISO clause to the criterion or area. Controls you mapped to SOC 2 or NIS2 requirements yourself are not counted here.

## What you can do

### Compare the two frameworks

Choose **{{ui:mapping.soc2}}** or **{{ui:mapping.nis2}}**. The cards with the lowest percentages are where your ISO 27001 work helps least.

## What happens next

- The figures follow your controls' statuses, and change as you implement controls.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| 0% on every card | None of your controls is an ISO 27001 control the table can relate | Use the framework's own page instead |
| **{{ui:mapping.loadError}}** | The figures could not load | Reload the page |

## Related

- [{{ui:frameworks.list.heading}}](frameworks.md), each framework's coverage from your own mappings.
- [A framework](framework-detail.md).
