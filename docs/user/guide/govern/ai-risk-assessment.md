---
route: /t/[tenantSlug]/risks/ai
---

# AI-assisted risk assessment

The {{ui:risks.ai.title}} page drafts risks for your register from your assets, the frameworks you follow and what you tell it about your organisation. You review every suggestion, keep the ones that fit, and only those are added to the register.

## Where to find it

Click **{{ui:risks.aiAssist}}** on the **{{ui:nav.risks}}** list, or in the AI panel beside the controls list.

## Who can use it

Owners, Admins and Editors: the roles that can create risks. Any other role who opens the page sees **{{ui:risks.ai.permissionRequired}}** and a link to the register.

## What it is for

Get a first draft of a risk register quickly, or check an existing one for gaps, without starting from a blank page.

## What you see

**{{ui:risks.ai.configureHeading}}.**

- **{{ui:risks.ai.frameworksLabel}}**: ISO 27001, NIS2 and SOC 2. Click any you follow.
- **{{ui:risks.ai.assetsLabel}}**: click **{{ui:risks.ai.loadAssets}}** to list your assets, then tick the ones to assess.
- **{{ui:risks.ai.contextLabel}}**: anything about your organisation that matters, up to 2,000 characters.

**The suggestions**, once generated. A summary line, **{{ui:risks.ai.acceptAll}}** and **{{ui:risks.ai.rejectAll}}**, and how many are accepted, rejected and still to decide. Each suggestion shows:

- its title, category and confidence;
- whether it came from the AI or from the baseline set used when the AI is unavailable;
- its description, threat and vulnerability;
- a suggested likelihood and impact on your workspace's matrix scale, with the band they fall in;
- the reasoning: why this risk, the asset characteristics behind it, and the control themes and controls that would reduce it.

## What you can do

1. Choose frameworks, assets and context, then click **{{ui:risks.ai.generateBtn}}**. Generating takes a few seconds.
2. Go through the suggestions and click **{{ui:risks.ai.accept}}** or **{{ui:risks.ai.reject}}** on each.
3. To correct one first, click **{{ui:risks.ai.edit}}**, change its **{{ui:risks.ai.editTitleLabel}}**, **{{ui:risks.ai.editDescriptionLabel}}**, **{{ui:risks.ai.likelihoodShort}}** or **{{ui:risks.ai.impactShort}}**, and click **{{ui:risks.ai.saveAccept}}**. The suggestion is marked **{{ui:risks.ai.edited}}**, and your version is the one added.
4. Click the apply button at the bottom to add the accepted suggestions to the register.

**{{ui:risks.ai.dismissAll}}** discards the whole set without adding anything.

## What happens next

Each accepted suggestion becomes a risk in the register, with the status Open and the likelihood and impact it carried, your corrections included. A suggestion whose title matches a risk you already have is linked to that risk instead of being added again, and the result says how many were linked that way. Review each new risk on its own page.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:risks.ai.fallbackNotice}}** | The AI was not available, so these are the standard baseline suggestions | Review them the same way, or try again later |
| **{{ui:risks.ai.assetsNone}}** | The workspace has no assets to choose from | Generate without assets, or add assets first |
| **{{ui:risks.ai.assetsLoadFailed}}** | The asset list could not load | Click **{{ui:risks.ai.loadAssets}}** again |
| **{{ui:risks.ai.selectOne}}** | You applied with nothing accepted | Accept at least one suggestion |
| **{{ui:risks.ai.generationFailed}}**, or the reason the server gave | No suggestions were generated | Follow the reason, then try again |
| **{{ui:risks.ai.applyFailed}}**, or the reason the server gave | Nothing was added | Follow the reason, then try again |

## Related

- [{{ui:risks.title}}](risks.md), where the accepted risks appear.
- [{{ui:assets.title}}](assets.md), the assets the suggestions draw on.
