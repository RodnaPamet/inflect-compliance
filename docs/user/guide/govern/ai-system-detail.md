---
route: /t/[tenantSlug]/risks/ai-systems/[systemId]
---

# An AI system

An AI system's page shows one entry of your EU AI Act register: how it is classified and why, what it is used for, the obligations that follow, and, for a high-risk system, the conformity documents you can draft for it.

## Where to find it

Open **{{ui:nav.risks}}** under **{{ui:nav.govern}}**, then **{{ui:risks.viewsMenu}}** › **{{ui:risks.viewLinks.aiSystems}}**, and click a system. The breadcrumb reads **{{ui:risks.breadcrumbDashboard}}** › **{{ui:risks.aiSystems.risksCrumb}}** › **{{ui:risks.aiSystems.title}}** › the system's name. Arrows beside the name step to the previous or next system.

## Who can use it

| Action | Roles |
| --- | --- |
| View the system | Every role |
| Classify a provisional entry, generate conformity drafts | Owner, Admin, Editor |

## What it is for

Keep the reasoning behind a system's EU AI Act tier in one place, see what it obliges you to do, and start the documents a high-risk system needs.

## What you see

**The header.** The system's name, its tier, the clause that decided it and whether you provide or deploy it.

**{{ui:risks.aiSystems.detail.classificationHeading}}.** **{{ui:risks.aiSystems.detail.rowStatus}}** (**{{ui:risks.aiSystems.detail.status_ACTIVE}}** or **{{ui:risks.aiSystems.detail.status_RETIRED}}**), **{{ui:risks.aiSystems.colRiskTier}}**, **{{ui:risks.aiSystems.detail.rowDrivingClause}}**, **{{ui:risks.aiSystems.colBasis}}**, **{{ui:risks.aiSystems.provider}}**, **{{ui:risks.aiSystems.detail.rowPurpose}}** and **{{ui:risks.aiSystems.new.useContextLabel}}**. A provisional entry, one nobody has classified yet, carries a notice saying so.

**The linked obligations.** The EU AI Act requirements that apply to the system, each with its framework's name, its code and its title. Click a title to open the framework.

**{{ui:risks.aiSystems.detail.conformityHeading}}.** For a high-risk system only: one button per document, and **{{ui:risks.aiSystems.detail.draftsHeading}}**, the drafts already queued for this system, each with its document, its review status and the date.

## What you can do

### Classify a provisional entry

Click **{{ui:risks.aiSystems.detail.classify}}** and answer every question. The tier and the clause that decided it follow from your answers. A classified entry cannot be made provisional again.

### Generate a conformity draft

For a high-risk system, click the document you need. A draft is created for a person to review; nothing is published, and a declaration of conformity is never issued on its own. The button then reads **{{ui:risks.aiSystems.detail.queued}}**, and a line tells you where to review the draft. While a draft of a document waits for review, its button stays off, even after a reload; once the draft is approved or rejected, you can generate another.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:risks.aiSystems.detail.notClassifiedNotice}}** | The entry is provisional | Owners, Admins and Editors click **{{ui:risks.aiSystems.detail.classify}}** |
| **{{ui:risks.aiSystems.detail.obligationsEmpty}}** | No requirement is linked to the system | Classify it, or link requirements on the register |
| **{{ui:risks.aiSystems.detail.classifyModal.failed}}** | The entry was not classified | Check that every question is answered, then try again |
| **{{ui:risks.aiSystems.detail.errorFallback}}**, or the reason the server gave | The draft was not created | Follow the reason given |

## Related

- [{{ui:risks.aiSystems.title}}](ai-systems.md), the register this system belongs to.
- [{{ui:agents.proposals.title}}](../manage/agent-proposals.md), where conformity drafts are reviewed.
