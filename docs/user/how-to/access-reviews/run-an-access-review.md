# Run an access review

An access review is a campaign in which a reviewer looks at each member's access to this workspace and decides, person by person, to keep it, take it away or change the role. When you close the campaign, Inflect carries out those decisions and produces a PDF you can keep as audit evidence.

## Before you start

- You need the Owner or Admin role to create and close a campaign. With a custom role, what you can do depends on the permissions your role was given.
- Choose the reviewer. Any member of the workspace can be one. Owners and Admins can also record decisions on any campaign, as a backup.
- Choose the scope. This guide covers the two scopes that review members:

| Scope | Who is in the campaign |
| --- | --- |
| {{ui:accessReviews.scopeAllUsers}} | Every member of the workspace who is active or invited |
| {{ui:accessReviews.scopeAdminOnly}} | The Owners and Admins only |

- The other two scopes, {{ui:accessReviews.scopeConnectedApp}} and {{ui:accessReviews.scopeAgent}}, review accounts in a connected directory and the workspace's registered agents. Each has a flow of its own, which this guide does not cover.
- The campaign reviews the people who are in scope when you create it, with the role each one has at that moment. Anyone who joins later is not in it.
- A campaign must cover at least one person. Inflect does not create a campaign whose scope matches nobody.
- You cannot change the name, scope, reviewer or due date after you create the campaign. Nor can you delete it.
- Nobody's access changes until you close the campaign.

## Steps

1. In the sidebar, under {{ui:nav.comply}}, click **{{ui:nav.tests}}**. The {{ui:controlTests.list.title}} page opens.
2. With **{{ui:controlTests.unified.tabPlans}}** selected, click **{{ui:controlTests.nav.accessReviews}}** in the toolbar above the table. Its icon is a person with a tick. The {{ui:accessReviews.title}} page opens.
3. Click **{{ui:accessReviews.newCampaign}}**. The {{ui:accessReviews.createTitle}} form opens.
4. In **{{ui:accessReviews.fieldName}}**, type a name, for example the quarter it covers.
5. In **{{ui:accessReviews.fieldDescription}}**, you can note the campaign's focus and why you are running it.
6. Under **{{ui:accessReviews.fieldScope}}**, choose **{{ui:accessReviews.scopeAllUsers}}** or **{{ui:accessReviews.scopeAdminOnly}}**.
7. In **{{ui:accessReviews.fieldReviewer}}**, choose the reviewer from the workspace's members. Type to search.
8. In **{{ui:accessReviews.fieldDue}}**, you can pick the date the reviewer should finish by. A due date is what sends the reviewer reminder emails.
9. Click **{{ui:accessReviews.createCampaign}}**.

## What happens next

- The campaign's page opens, with the status **OPEN**. It lists one row per person in scope, and shows the reviewer's email address under **{{ui:accessReviews.dlReviewer}}**.
- Inflect does not tell the reviewer about the new campaign. Let them know yourself and send them the page. Their part is in [Record access review decisions](record-access-review-decisions.md).
- If you set a due date, the reviewer gets a reminder email each day while decisions are pending. The reminders run from 7 days before the due date to 3 days after it. Once the campaign is more than 7 days overdue, every active Owner and Admin also gets an email each day. These emails go out only if your workspace sends email notifications.
- The first decision recorded moves the campaign to **IN_REVIEW**. The bar at the top of the campaign's page shows how many people have a decision, out of the total.
- Creating the campaign, and every decision recorded or discarded in it, is written to the workspace's audit log.

## Close the campaign

When every person has a decision, close the campaign to carry the decisions out.

1. On the {{ui:accessReviews.title}} page, click the campaign's name.
2. Click **{{ui:accessReviews.closeCampaign}}**. It stays greyed out until every row has a decision.
3. Read the {{ui:accessReviews.closeTitle}} dialog, then click **{{ui:accessReviews.closeGenerate}}**.

Closing does this to each person:

| Decision | What closing does |
| --- | --- |
| **CONFIRM** | Nothing. Their access stays as it is |
| **REVOKE** | Deactivates their membership. Their record stays in the members list, and they lose access to the workspace. To let them back in, invite them again |
| **MODIFY** | Gives them the built-in role the reviewer chose. Any custom role they had is removed |

A person whose membership has been removed since the campaign started is skipped.

Three rules protect the workspace's Owners. If any of them applies, the whole close is refused and no decision is carried out:

- A campaign never makes anyone an Owner, and never gives anyone a custom role. The reviewer can only choose Admin, Editor, Auditor or Reader.
- If a decision would revoke or change the role of someone who is an Owner when the campaign closes, only an Owner can close it.
- The campaign cannot close if it would leave the workspace without an active Owner.

## The evidence it files

Once closed, the campaign's status is **CLOSED** and the page shows when, under **{{ui:accessReviews.dlClosed}}**. Its decisions can no longer change.

Click **{{ui:accessReviews.downloadEvidence}}** on the campaign's page for the evidence. Every role can download it. The PDF is titled **Access Review Evidence** and is marked FINAL. It holds:

- the campaign's name and description, its scope, the reviewer, who created it, who closed it, and when, in UTC;
- a summary that counts the people in the campaign, the confirmed, revoked and modified decisions, and the decisions executed at close, confirmations included;
- a table with one row per person: their role when the campaign started, the decision, the new role for a modify, and the outcome.

The outcome column reads:

| Outcome | Meaning |
| --- | --- |
| **EXECUTED** | The revoke or role change was carried out |
| **NO_CHANGE** | The access was confirmed, so nothing changed |
| **SKIPPED_STALE** | The person's membership no longer existed, so nothing was done |
| **SKIPPED_LAST_OWNER** | Carrying it out would have left the workspace without an active Owner, so it was held back |

The reviewers' justifications are not copied into the PDF.

The PDF stays with the campaign. It is not added to **{{ui:nav.evidence}}**. To use it as evidence for a control, download it and upload it there.

Each decision carried out, and the close itself, is also written to the workspace's audit log. Open it from **{{ui:admin.auditLog}}** on the {{ui:admin.title}} page.

## If something goes wrong

| What you see | What it means | What to do |
| --- | --- | --- |
| {{ui:accessReviews.nameReviewerRequired}} | The form has no name or no reviewer | Fill in both, then click **{{ui:accessReviews.createCampaign}}** again |
| **Permission denied** when you create a campaign | Your role cannot create campaigns | Ask an Owner or Admin |
| **No memberships matched the requested scope — the campaign would have zero subjects.** | Nobody in the workspace is in that scope | Choose **{{ui:accessReviews.scopeAllUsers}}** |
| **{{ui:accessReviews.closeCampaign}}** is greyed out | At least one person has no decision yet | Ask the reviewer to finish, or record the remaining decisions yourself |
| No **{{ui:accessReviews.closeCampaign}}** button | Your role cannot close campaigns, or the campaign is already closed | Ask an Owner or Admin |
| A message that includes **only an OWNER can close this campaign** | A decision revokes or changes the role of an Owner, and you are not an Owner | Ask an Owner to close it. Or ask the reviewer to discard those decisions and record them again |
| A message that includes **would leave the tenant with zero ACTIVE OWNERs** | The decisions would remove the last active Owner | Make another member an Owner first, or have the reviewer discard and re-record the decisions on Owners |
| A message that includes **The membership holds a role that carries no custom role but still carries one** | A revoke targets an Owner or AI admin who still has a custom role from before that rule applied | Ask an Owner to click **{{ui:admin.members.removeCustomRole}}** for that member on the {{ui:admin.nav.members}} page, then close again |
| The campaign is closed, but there is no **{{ui:accessReviews.downloadEvidence}}** button | The decisions were carried out, but the PDF could not be produced | The decisions and their outcomes are in the audit log. The campaign page has no way to produce the PDF again |
