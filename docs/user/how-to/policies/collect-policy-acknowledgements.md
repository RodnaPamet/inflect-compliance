# Collect policy acknowledgements

Ask staff to confirm they have read a published policy, then track who has. Each acknowledgement is recorded against the version that was live when the person gave it, so you can show an auditor who accepted which text, and when.

## Before you start

- To ask people, you need the Owner or Admin role. With a custom role, you need one whose base role is Admin.
- To see who has acknowledged, you need the Owner, Admin or Auditor role. With a custom role, you need one whose base role is Admin or Auditor. Auditors see the roster and the attestation log but cannot ask people.
- Anyone in the workspace can acknowledge a published policy, whatever their role, whether or not they were asked.
- The policy must be published. See [Publish a policy](publish-a-policy.md).
- Decide who must acknowledge it: everyone, everyone with a particular role, or named people.

## Steps

### Ask people to acknowledge

1. Click **{{ui:nav.policies}}** under {{ui:nav.manage}} in the sidebar, then click the policy's title.
2. Open the **{{ui:policies.detail.tabAcknowledgements}}** tab.
3. Under {{ui:policies.ack.rosterTitle}}, click **{{ui:policies.ack.requestAck}}**. The {{ui:policies.ack.requestTitle}} dialog opens.
4. In {{ui:policies.ack.audienceLabel}}, choose who must acknowledge it:
    - **{{ui:policies.ack.audienceAll}}**: every active member of the workspace, you included.
    - **{{ui:policies.ack.audienceRole}}**: then choose the {{ui:policies.ack.roleLabel}}: {{ui:policies.ack.role.OWNER}}, {{ui:policies.ack.role.ADMIN}}, {{ui:policies.ack.role.EDITOR}}, {{ui:policies.ack.role.READER}} or {{ui:policies.ack.role.AUDITOR}}. AI admins cannot be chosen by role; pick them by name instead.
    - **{{ui:policies.ack.audienceUsers}}**: choose each person in {{ui:policies.ack.usersLabel}}.
5. Click **{{ui:policies.ack.requestConfirm}}**. With {{ui:policies.ack.audienceUsers}}, it stays greyed out until you choose at least one person.
6. A message confirms how many members were asked, and they appear in the roster.

You can ask again at any time, for example when new people join. Each request adds only people who have not been asked yet for this version.

### Acknowledge a policy

Every member does this for themselves.

1. Click **{{ui:nav.policies}}** under {{ui:nav.manage}} in the sidebar, then click the policy's title.
2. Read the policy on the **{{ui:policies.detail.tabCurrent}}** tab.
3. Open the **{{ui:policies.detail.tabAcknowledgements}}** tab. Under {{ui:policies.ack.yourStatusTitle}}, it reads {{ui:policies.ack.youOutstanding}}
4. Click **{{ui:policies.ack.acknowledge}}**.
5. A message reads {{ui:policies.ack.acknowledgedToast}} The section now says you acknowledged the policy, and on what date.

### See who has acknowledged

Owners, Admins and Auditors can do this. On the policy's **{{ui:policies.detail.tabAcknowledgements}}** tab, the {{ui:policies.ack.rosterTitle}} shows which version it is for, the share of people who have acknowledged, and a progress bar. Below that, people who still owe an acknowledgement come first. Each person who was asked shows who asked them and when. Everyone shows one of these:

| Badge | Meaning |
| --- | --- |
| A date | They acknowledged the live version on that date |
| {{ui:policies.ack.statusSuperseded}} | They acknowledged an earlier version, but not the one that is live now. This does not count |
| {{ui:policies.ack.statusOutstanding}} | They have not acknowledged it |

{{ui:policies.ack.voluntary}} beside a name means that person acknowledged without being asked. Under the roster, the **{{ui:policies.ack.attestationsTitle}}** lists everyone who acknowledged the live version, newest first, with the date and time.

On the {{ui:policies.title}} page, the {{ui:policies.colHeaders.acknowledgement}} column shows how many people have acknowledged each policy out of how many were asked. To list only the policies someone still owes, open the **Filter** button and choose {{ui:policies.filters.acknowledgement}} › {{ui:policies.filterEnums.acknowledgement.outstanding}}.

## What happens next

- Each person you ask gets a notification in Inflect, under the bell at the top of the page, that starts **Action required: acknowledge**. Clicking it opens the policy. Asking again notifies only the people it adds. Anyone already asked for the version that is live, including people carried over by a publish or a rollback, is not notified a second time.
- When a later version of the policy is published, or an Owner or Admin rolls the policy back to an earlier version, everyone who was asked is asked again for the version that is now live. Their earlier acknowledgement shows as {{ui:policies.ack.statusSuperseded}} until they acknowledge again. They get a notification that starts **Re-acknowledgement required**. This happens each time: a rollback, or publishing a version that was published before, notifies them again even if they were already notified about that version.
- Only acknowledgements of the live version count towards the roster's figures.
- Each request and each acknowledgement is listed on the policy's **{{ui:policies.detail.tabActivity}}** tab, as {{ui:policies.detail.event.ackRequested}} and {{ui:policies.detail.event.attested}}, and recorded in the workspace's audit log.
- While a policy is not published, for example after it is archived, nobody can acknowledge it. The roster then describes the last published version and is marked {{ui:policies.ack.rosterNotLive}}.

## If something goes wrong

| What you see | What it means | What to do |
| --- | --- | --- |
| {{ui:policies.ack.notPublished}} | The policy is not published, so there is nothing to acknowledge yet | Publish it first. See [Publish a policy](publish-a-policy.md) |
| There is no **{{ui:policies.ack.requestAck}}** button | The policy is not published, or your role cannot ask people | Publish the policy, or ask an Owner or Admin |
| There is no {{ui:policies.ack.rosterTitle}} on the tab | Your role cannot see who has acknowledged. Only Owners, Admins and Auditors can | Ask an Owner, Admin or Auditor |
| {{ui:policies.ack.requestFailed}} | The request did not go through. Often the role you chose has no active members | Choose another audience, or reload the page and try again |
| {{ui:policies.ack.noneRequired}} | Nobody has been asked to acknowledge the live version | Click **{{ui:policies.ack.requestAck}}** |
| {{ui:policies.ack.acknowledgeFailed}} | Your acknowledgement was not saved. The policy may have stopped being live | Reload the page. If the policy is still published, try again |
| Someone you asked shows {{ui:policies.ack.statusSuperseded}} | A newer version of the policy was published after they acknowledged | Ask them to read and acknowledge the new version |
