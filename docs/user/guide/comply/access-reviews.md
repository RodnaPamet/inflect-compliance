---
route: /t/[tenantSlug]/access-reviews
---

# {{ui:accessReviews.title}}

The {{ui:accessReviews.title}} page lists the workspace's access review campaigns. In each campaign a reviewer goes through a set of accounts and decides, one by one, whether each keeps its access, loses it or changes role. The page shows every campaign's status, what it reviews, the period it covers, its due date and how far the reviewer has got, and it is where Owners and Admins start a new campaign.

## Where to find it

The page is not in the sidebar. Open **{{ui:nav.tests}}** under **{{ui:nav.comply}}** in the sidebar. The {{ui:controlTests.list.title}} page opens. With **{{ui:controlTests.unified.tabPlans}}** selected, click **{{ui:controlTests.nav.accessReviews}}** in the toolbar above the table. Its icon is a person with a tick.

The breadcrumb reads **{{ui:accessReviews.crumbDashboard}}** › **{{ui:accessReviews.crumbTests}}** › **{{ui:accessReviews.crumbList}}**, and a back link above it returns you to the page you came from. A campaign with a due date also appears on the {{ui:calendar.title}}, which you open from **{{ui:nav.calendar}}** in the sidebar, and its entry opens the campaign.

## Who can use it

| Action | Roles |
| --- | --- |
| See the list of campaigns and open any campaign | Every role: Owner, Admin, Editor, Reader, Auditor and AI admin |
| Start a campaign | Owner, Admin |
| Record decisions in a campaign | The campaign's reviewer, whatever their role, and any Owner or Admin |
| Change a campaign's reviewer or due date, and close it | Owner, Admin |

Only Owners and Admins see **{{ui:accessReviews.newCampaign}}**. Nobody records the decision on their own access, whatever their role, and nobody decides on an agent they own.

Every role sees every campaign in the list. Inside a campaign that reviews registered agents, the agents themselves are shown only to the campaign's reviewer and to members who can read the agent register.

If your workspace uses custom roles, what you can do depends on the permissions your role was given. The **{{ui:accessReviews.newCampaign}}** button appears only when both those permissions and the built-in role your custom role is based on allow you to start a campaign.

## What it is for

Use access reviews to show, period by period, that someone accountable checked who can reach what and acted on it. A campaign fixes the list of accounts it covers when it is created. The reviewer records a decision for each, and closing the campaign carries the decisions out and produces an evidence PDF for your auditors.

## What you see

**The header.** The page title, a count of campaigns, and **{{ui:accessReviews.newCampaign}}** for Owners and Admins.

**The table.** The newest campaigns come first. The page has no search, filters or sorting.

| Column | What it shows |
| --- | --- |
| {{ui:accessReviews.colCampaign}} | The campaign's name. Click it to open the campaign |
| {{ui:accessReviews.colStatus}} | **{{ui:accessReviews.statusLabels.OPEN}}** until the first decision is recorded, then **{{ui:accessReviews.statusLabels.IN_REVIEW}}**, and **{{ui:accessReviews.statusLabels.CLOSED}}** once the campaign is closed |
| {{ui:accessReviews.colScope}} | What the campaign reviews, as described under the scopes below. {{ui:accessReviews.scopeLabels.CUSTOM}} is a set of members chosen through the Inflect API; the form on this page does not offer it |
| {{ui:accessReviews.colPeriod}} | The period the campaign covers, as a start and an end date, or a dash |
| {{ui:accessReviews.colDue}} | The date the reviewer should finish by, or a dash |
| {{ui:accessReviews.colProgress}} | A bar and a count of the accounts that have a decision, out of all the accounts in the campaign. The bar is green once the campaign is closed |

Clicking elsewhere on a row does nothing; use the campaign's name.

**A campaign's own page.** It lists one row per account in the campaign, with a decision list in each row for the people who may decide it, and the buttons that change the reviewer and the due date, close the campaign and download its evidence PDF. The how-tos under Related walk through it.

## What you can do

### Start a campaign

Click **{{ui:accessReviews.newCampaign}}**. The **{{ui:accessReviews.createTitle}}** form has these fields:

- **{{ui:accessReviews.fieldName}}**, required, and **{{ui:accessReviews.fieldDescription}}**.
- **{{ui:accessReviews.fieldScope}}**, one of five, starting on the first:

| Scope | What the campaign reviews |
| --- | --- |
| {{ui:accessReviews.scopeAllUsers}} | Every member of the workspace who is active or invited |
| {{ui:accessReviews.scopeAdminOnly}} | The workspace's Owners and Admins |
| {{ui:accessReviews.scopeConnectedApp}} | The accounts synced from a connected directory. Choose **{{ui:accessReviews.fieldDirectory}}**: {{ui:accessReviews.directoryAll}}, or one of {{ui:accessReviews.directoryOkta}}, {{ui:accessReviews.directoryGoogle}}, {{ui:accessReviews.directoryEntra}} and {{ui:accessReviews.directoryAd}}. A directory with no synced accounts is greyed out |
| {{ui:accessReviews.scopeLegacyApp}} | The accounts of one legacy application, chosen in **{{ui:accessReviews.fieldLegacyConnection}}**, from its latest complete read |
| {{ui:accessReviews.scopeAgent}} | The workspace's registered agents. Choose **{{ui:accessReviews.fieldPreparer}}**, the agent that prepares every agent's reviewer pack except its own, and if you want, a **{{ui:accessReviews.fieldCrossPreparer}}** for that one pack. Without one, a person prepares it |

- **{{ui:accessReviews.fieldReviewer}}**, required: an active member of the workspace. Type to search.
- **{{ui:accessReviews.fieldPeriod}}**, a start and an end date. It is printed on the evidence PDF.
- **{{ui:accessReviews.fieldDue}}**. A due date is what sends the reviewer reminder emails.

Click **{{ui:accessReviews.createCampaign}}**. The campaign's page opens. For a {{ui:accessReviews.scopeAgent}} campaign, Inflect then asks the preparing agent for the reviewer packs. If that does not succeed, the campaign is kept, and while it is **{{ui:accessReviews.statusLabels.OPEN}}** its page offers Owners and Admins **{{ui:accessReviews.agentPreparePacks}}**.

[Run an access review](../../how-to/access-reviews/run-an-access-review.md) takes you through a member campaign and a legacy application campaign step by step, including what each refusal means.

### Follow a campaign's progress

The {{ui:accessReviews.colStatus}} and {{ui:accessReviews.colProgress}} columns show where each campaign stands without opening it. Open a campaign to see which accounts are still undecided.

## What happens next

- A campaign covers the accounts that were in scope when it was created, with the access each had then. Anyone who joins later is not in it.
- Inflect does not tell the reviewer about the new campaign. Let them know yourself.
- If the campaign has a due date, the reviewer gets a reminder email each day while decisions are pending, from 7 days before the due date to 3 days after it. Once it is more than 7 days overdue, every active Owner and Admin is emailed too. These emails go out only if your workspace sends email notifications.
- Nobody's access changes until an Owner or Admin closes the campaign. Closing carries out the decisions and produces the evidence PDF.
- Creating a campaign, changing its reviewer or due date, every decision and the close are all written to the workspace's audit log.
- A campaign cannot be deleted, and its name, scope and period cannot change once it is created.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:accessReviews.emptyListReadOnly}}** | The workspace has no campaigns. Owners and Admins see the same message with a prompt to click **{{ui:accessReviews.newCampaign}}** | An Owner or Admin starts one |
| **{{ui:accessReviews.nameReviewerRequired}}** | The form has no name or no reviewer | Fill in both, then try again |
| **{{ui:accessReviews.legacyConnectionRequired}}** | You chose {{ui:accessReviews.scopeLegacyApp}} without choosing the application | Choose it |
| **{{ui:accessReviews.legacyConnectionsNone}}** | No legacy application is connected | Connect one under **{{ui:nav.admin}}** → **{{ui:admin.nav.integrations}}** |
| **{{ui:accessReviews.directoryNoneSynced}}** | No connected directory has synced accounts | Click **{{ui:accessReviews.directoryConnectLink}}** |
| A message saying the campaign was not created, followed by the fields to fix | A field was refused, such as a date that is not a valid date | Correct those fields and try again |
| **No memberships matched the requested scope — the campaign would have zero subjects.** | Nobody in the workspace is in that scope | Choose a different scope |
| A message that includes **REVIEWER_NOT_A_MEMBER** | The reviewer is not an active member of the workspace | Choose an active member |
| **{{ui:accessReviews.createFailed}}** | The campaign was not created, and the server gave no reason | Try again |
| A banner saying only the first 5,000 results are shown | The workspace has more than 5,000 campaigns, and the oldest are not listed. The page has no filters to narrow it | Open an older campaign from a link to it, such as its entry on the {{ui:calendar.title}} |

## Related

- [Run an access review](../../how-to/access-reviews/run-an-access-review.md): create, change, close, and the evidence a campaign files.
- [Record access review decisions](../../how-to/access-reviews/record-access-review-decisions.md): the reviewer's part.
- [{{ui:admin.members.title}}](../admin/members.md), where a member's access can be changed outside a campaign.
