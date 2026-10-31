---
route: /t/[tenantSlug]/clauses
---

# {{ui:clauses.title}}

The {{ui:clauses.title}} page tracks your progress through the management-system clauses of ISO 27001, clauses 4 to 10, the part of the standard that sits before the Annex A controls. {{ui:clauses.subtitle}}

## Where to find it

On the ISO 27001 framework's page, click **{{ui:frameworks.detail.clauseTracker}}** in the header.

## Who can use it

| Action | Roles |
| --- | --- |
| Read the clauses | Every role |
| Change a clause's status and notes | Owner, Admin, Editor |

Every other role sees each clause's status as a badge, and its notes as text.

## What it is for

Keep track of the clauses an ISO 27001 auditor checks first: the scope, leadership, planning, support, operation, performance evaluation and improvement of your management system. Controls cover Annex A; this page covers the rest.

## What you see

On the left, one row per clause, with its number, its title and its status: **{{ui:clauses.notStarted}}**, **{{ui:clauses.inProgress}}**, **{{ui:clauses.ready}}** or **{{ui:clauses.needsReview}}**.

On the right, the clause you selected: its description, **{{ui:clauses.requiredArtifacts}}**, the documents an auditor expects to see for it, a **{{ui:clauses.checklist}}** of what the clause asks for, and **{{ui:clauses.notes}}**. The checklist is for reference: its items cannot be ticked.

## What you can do

### Record a clause's progress

1. Click a clause on the left.
2. Choose its status from the list at the top right.

The status saves straight away, and the page says **{{ui:clauses.statusSaved}}**

### Keep notes on a clause

Under **{{ui:clauses.notes}}**, write what has been done for the clause and what is still open, then click **{{ui:clauses.saveNotes}}**. The button appears once you change the text. The page says **{{ui:clauses.notesSaved}}**

## What happens next

- The statuses are your workspace's own record. They do not feed a readiness score.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| {{ui:clauses.selectClause}} | No clause is selected | Click one on the left |
| **{{ui:clauses.saveFailed}}** | The status or the notes were not saved, and the page shows what is stored | Try again |
| **{{ui:clauses.noNotes}}** | Nobody has written notes for the clause | Write some, if your role can |

## Related

- [{{ui:controls.list.pageTitle}}](controls.md), the Annex A controls.
- [A framework](framework-detail.md), ISO 27001's requirements and your mappings.
