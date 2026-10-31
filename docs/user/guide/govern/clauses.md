---
route: /t/[tenantSlug]/clauses
---

# {{ui:clauses.title}}

The {{ui:clauses.title}} page tracks your progress through the management-system clauses of ISO 27001, clauses 4 to 10, the part of the standard that sits before the Annex A controls. {{ui:clauses.subtitle}}

## Where to find it

No menu or button leads to the page: it opens from a link to it.

## Who can use it

| Action | Roles |
| --- | --- |
| Read the clauses | Every role |
| Change a clause's status | Owner, Admin, Editor |

## What it is for

Keep track of the clauses an ISO 27001 auditor checks first: the scope, leadership, planning, support, operation, performance evaluation and improvement of your management system. Controls cover Annex A; this page covers the rest.

## What you see

On the left, one row per clause, with its number, its title and its status: **{{ui:clauses.notStarted}}**, **{{ui:clauses.inProgress}}**, **{{ui:clauses.ready}}** or **{{ui:clauses.needsReview}}**.

On the right, the clause you selected: its description, **{{ui:clauses.requiredArtifacts}}**, the documents an auditor expects to see for it, and a **{{ui:clauses.checklist}}** of what the clause asks for. The checklist is for reference: its items cannot be ticked.

## What you can do

### Record a clause's progress

1. Click a clause on the left.
2. Choose its status from the list at the top right.

The status saves straight away.

## What happens next

- The statuses are your workspace's own record. They do not feed a readiness score.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| {{ui:clauses.selectClause}} | No clause is selected | Click one on the left |
| A status that comes back after a reload | The change was not saved | Ask an Owner, Admin or Editor to make it |

## Related

- [{{ui:controls.list.pageTitle}}](controls.md), the Annex A controls.
- [A framework](framework-detail.md), ISO 27001's requirements and your mappings.
