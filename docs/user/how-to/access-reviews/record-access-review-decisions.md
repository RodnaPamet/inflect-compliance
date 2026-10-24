# Record access review decisions

As the reviewer of an access review campaign, you go through the people in it and record one decision for each: keep their access, take it away, or change their role. Your decisions take effect when an Owner or Admin closes the campaign, and until then you can change any of them.

## Before you start

- You must be the campaign's reviewer. The campaign's page names the reviewer under **{{ui:accessReviews.dlReviewer}}**. Owners and Admins can also record decisions on any campaign, as a backup, and the audit log records who made each one.
- Any role can be a reviewer. With a custom role, what you can do depends on the permissions your role was given.
- The campaign must still be open, with the status **OPEN** or **IN_REVIEW**. A closed campaign cannot change.
- Your decisions change nobody's access on their own. Closing the campaign is what carries them out. See [Run an access review](run-an-access-review.md).

## Steps

1. In the sidebar, under {{ui:nav.comply}}, click **{{ui:nav.tests}}**. The {{ui:controlTests.list.title}} page opens.
2. With **{{ui:controlTests.unified.tabPlans}}** selected, click **{{ui:controlTests.nav.accessReviews}}** in the toolbar above the table. Its icon is a person with a tick.
3. In the {{ui:accessReviews.colCampaign}} column, click the campaign's name. Its page lists one row per person, with these columns:

| Column | What it shows |
| --- | --- |
| {{ui:accessReviews.colSubject}} | The person's name and email address |
| {{ui:accessReviews.colSnapshotRole}} | Their role when the campaign was created, such as **ADMIN** |
| {{ui:accessReviews.colLiveRole}} | Their role now. {{ui:accessReviews.deleted}} means they have since been removed from the workspace |
| {{ui:accessReviews.colLastActive}} | When they were last active in this workspace, or {{ui:accessReviews.never}} |
| {{ui:accessReviews.colDecision}} | Your decision, once you have recorded it |

4. In a person's {{ui:accessReviews.colDecision}} column, open the **{{ui:accessReviews.decidePrompt}}** list and choose one of these:
    - **{{ui:accessReviews.confirmAccess}}** keeps their access as it is.
    - **{{ui:accessReviews.revokeAccess}}** deactivates their membership when the campaign closes.
    - **{{ui:accessReviews.modifyRole}}** gives them another role when the campaign closes.
5. A dialog opens with the person's email address. It shows their role when the campaign was created, and their role now if that has changed.
6. For **{{ui:accessReviews.modifyRole}}**, choose the new role in **{{ui:accessReviews.targetRole}}**: **ADMIN**, **EDITOR**, **AUDITOR** or **READER**. The list leaves out the role the person had when the campaign was created. A campaign never makes anyone an Owner or an AI admin, and never gives a custom role. Any custom role the person has is removed when the campaign closes.
7. In the justification box, say why, in up to 2,000 characters. The box reads {{ui:accessReviews.justOptional}} for a confirm and {{ui:accessReviews.justRecommended}} for a revoke or a role change.
8. Click **{{ui:accessReviews.submitDecision}}**.
9. Repeat steps 4 to 8 for every row.

## What happens next

- The row shows your decision as a badge: **CONFIRM**, **REVOKE**, or **MODIFY** with the new role, such as **MODIFY → EDITOR**.
- The first decision anyone records moves the campaign from **OPEN** to **IN_REVIEW**.
- The bar at the top of the page counts the people with a decision, out of the total.
- Every decision is written to the workspace's audit log, naming who made it.
- When every row has a decision, an Owner or Admin can close the campaign. Inflect does not tell them that you have finished, so let them know.
- If you revoke or change the role of an Owner, only an Owner can close the campaign.
- If the campaign has a due date, you get a reminder email each day while decisions are pending, from 7 days before the due date to 3 days after it. These emails go out only if your workspace sends email notifications.

## Change a decision

You can discard a decision and record a new one at any time before the campaign closes.

1. Click **{{ui:accessReviews.undoVerdict}}** beside the decision's badge.
2. In **{{ui:accessReviews.undoReasonLabel}}**, type why, in at least 3 characters.
3. Click **{{ui:accessReviews.undoConfirm}}**.

The row goes back to undecided, and you can record a decision again. The reason is kept in the audit log. The record of each person's access when the campaign was created stays as it was.

## If something goes wrong

| What you see | What it means | What to do |
| --- | --- | --- |
| Rows show {{ui:accessReviews.pending}} and there is no **{{ui:accessReviews.decidePrompt}}** list | You are not this campaign's reviewer and not an Owner or Admin, or the campaign is closed | Check the name under **{{ui:accessReviews.dlReviewer}}**. If the reviewer cannot do it, ask an Owner or Admin |
| A message that includes **This decision has already been recorded.** | Someone recorded a decision on this row after you opened the page | Reload the page. To change that decision, discard it and record yours |
| A message that includes **This campaign is closed; decisions are immutable.** | The campaign was closed after you opened the page | Reload the page. Its decisions can no longer change |
| A message that includes **Permission denied** | Your custom role does not allow recording decisions | Ask an Owner or Admin |
| **{{ui:accessReviews.undoConfirm}}** is greyed out | The reason is shorter than 3 characters | Type a longer reason |
| No **{{ui:accessReviews.undoVerdict}}** beside a decision | The campaign is closed and its decisions have been carried out, or you are not its reviewer | After the close, the campaign cannot change. Ask an Owner or Admin to change the person's access on the {{ui:admin.nav.members}} page |
| A person you expected is not in the list | They joined after the campaign was created, or were not active or invited then. For {{ui:accessReviews.scopeAdminOnly}}, they were not an Owner or Admin | Ask an Owner or Admin to start a new campaign |
