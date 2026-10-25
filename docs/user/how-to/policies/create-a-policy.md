# Create a policy

A policy sets out how your organisation works, such as who may access what or how incidents are handled. Start from a template to get written content, or start blank and write your own. A new policy is a draft: nobody is asked to follow it until it has been approved and published.

## Before you start

- You need the Owner, Admin or Editor role. With a custom role, what you can do depends on the permissions your role was given.
- Decide whether to start from a template. A template brings ready-written content, and often a review schedule and a list of evidence to keep. Your workspace may have no templates.
- Have the policy's title ready. It is the only field you must fill in.

## Steps

1. Click **{{ui:nav.policies}}** under {{ui:nav.manage}} in the sidebar. The {{ui:policies.title}} page opens.
2. Click **{{ui:policies.list.addBtn}}**, the button with a plus sign above the table. The {{ui:policies.new.titleBlank}} dialog opens.
3. In {{ui:policies.new.startWith}}, choose **{{ui:policies.new.modeNew}}** for a blank policy or **{{ui:policies.new.modeFromTemplate}}** to use a template. You can switch between the two without losing what you have typed.
4. From a template: under {{ui:policies.new.chooseTemplate}}, click the template you want. Most show their category under the title. Choosing one fills {{ui:policies.new.fieldTitle}} with the template's title, unless you have already typed a title, and sets {{ui:policies.new.fieldCategory}} to the template's category. If you choose no template, the policy is created empty.
5. In {{ui:policies.new.fieldTitle}}, type or adjust the policy's name.
6. If you like, add a one-line summary in {{ui:policies.new.fieldDescription}} and choose a {{ui:policies.new.fieldCategory}}, such as **Information Security** or **Access Control**.
7. For a blank policy, you can write the first version's text under {{ui:policies.new.fieldContent}}. If you leave it empty, the policy has no content until you add a version.
8. Click **{{ui:policies.createPolicy}}**. It stays greyed out until the policy has a title, and reads {{ui:policies.new.creating}} while it works.

The policy's page opens.

**Suggested controls.** Some templates are mapped to framework requirements. If your workspace already has controls for those requirements, a dialog first suggests linking the new policy to them. Some suggestions may be ticked already. Tick the controls the policy supports and click the link button, or click **{{ui:policies.templates.skip}}**. The suggestions are a starting point to check, not a compliance claim. You can link controls later from the policy's **{{ui:policies.detail.tabTraceability}}** tab.

## Write or change the content

Each save creates a new version of the policy. A blank policy needs one before it can be sent for approval. Use these steps while the policy is a draft; this guide does not cover changing a published policy.

1. On the policy's page, click **{{ui:policies.detail.version}}**, the button with a plus sign at the top, or open the **{{ui:policies.detail.tabEditor}}** tab. The form opens under {{ui:policies.detail.createNewVersion}}.
2. Choose how to provide the content:
    - **{{ui:policies.detail.modeMarkdown}}**: write the text in the editor.
    - **{{ui:policies.detail.externalLink}}**: the policy lives in another system, such as Google Docs or Confluence. Paste its address in {{ui:policies.detail.externalUrlLabel}}.
3. If you like, describe what changed in {{ui:policies.detail.changeSummaryLabel}}.
4. Click **{{ui:policies.detail.version}}** below the form. It reads {{ui:policies.detail.saving}} while it works.
5. A message reads {{ui:policies.detail.versionCreatedToast}}, and the **{{ui:policies.detail.tabVersions}}** tab opens with the new version at the top.

Before you save, check the editor's starting text. If the policy already has more than one version and has never been published, the editor can start from an older version rather than the newest one. Compare it with the newest version on the {{ui:policies.detail.tabVersions}} tab, under **{{ui:policies.detail.showContent}}**.

## What happens next

- The policy appears on the {{ui:policies.title}} page with the status {{ui:policies.filterEnums.status.draft}}.
- The {{ui:policies.detail.tabCurrent}} tab shows {{ui:policies.detail.guideDraftTitle}}, with **{{ui:policies.detail.gotoVersions}}** to take you to the next step.
- A policy made from a template already has its first version, written from the template. You are its owner. If the template gives a review frequency, the policy has a review schedule and a next review date.
- If the template lists evidence to keep, the {{ui:policies.detail.tabCurrent}} tab shows an **{{ui:policies.evidence.title}}** checklist. Link each item to the evidence that proves the policy operates.
- Creating the policy and each version is recorded on its **{{ui:policies.detail.tabActivity}}** tab and in the workspace's audit log.
- Next, send the policy for approval. See [Publish a policy](publish-a-policy.md).

## If something goes wrong

| What you see | What it means | What to do |
| --- | --- | --- |
| There is no **{{ui:policies.list.addBtn}}** button | Your role cannot create policies | Ask an Owner, Admin or Editor |
| **{{ui:policies.createPolicy}}** stays greyed out | The policy has no title yet | Type a title |
| {{ui:policies.new.titleEmpty}} | The title holds only spaces | Type a real title |
| {{ui:policies.new.templatesEmpty}} | Your workspace has no policy templates | Choose **{{ui:policies.new.modeNew}}** and write the policy yourself |
| {{ui:policies.new.discard}} | You are closing the dialog with details filled in | Cancel to keep editing, or confirm to throw the details away |
| The policy page reads {{ui:policies.detail.versionEmpty}} | The policy has no content yet | Add a version, as described under "Write or change the content" above |
| Clicking **{{ui:policies.detail.version}}** in the editor does nothing | The editor or the address field is empty | Write some text, or paste the document's address |
| {{ui:policies.detail.errFileUpload}} | The editor's **{{ui:policies.detail.modeFileUpload}}** option did not save the file, and no version was created | Put the document where colleagues can open it, such as a shared drive, and add it with **{{ui:policies.detail.externalLink}}** instead |
| There is no **{{ui:policies.detail.tabEditor}}** tab | Your role cannot change policies | Ask an Owner, Admin or Editor |
