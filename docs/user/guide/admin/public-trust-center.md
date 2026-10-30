---
route: /trust/[slug]
---

# Public {{ui:external.trustCenter.metaTitleFallback}}

The public {{ui:external.trustCenter.metaTitleFallback}} is a web page about your organisation's security that anyone can open without signing in: your customers, prospects and their procurement teams. It shows what your workspace chooses to publish, and nothing else. This guide is for the people who run the workspace, so they know what visitors see.

## Where to find it

The page's address is shown on the workspace's **{{ui:admin.trustCenter.title}}** settings, after **{{ui:admin.trustCenter.publicUrlLabel}}**, once it is published. Share that address, or link to it from your own website. The address ends in the workspace's short name.

While the trust center is not published, the address shows a page-not-found page, and says nothing about whether the workspace exists.

## Who can use it

| Action | Who |
| --- | --- |
| Open the page | Anyone with the address, signed in or not |
| Change what it shows | Owners and Admins, on the **{{ui:admin.trustCenter.title}}** settings |
| Publish or unpublish it | Owners only |

## What it is for

Use it to answer the security questions every customer asks, once, in public: which standards you follow, how you protect their data, which documents they can read, and whom to contact. It saves sending the same answers in every questionnaire.

## What you see

Each part appears only when the workspace has filled it in:

- **The name and tagline** at the top: the display name the workspace chose, and an optional one-line description.
- **{{ui:external.trustCenter.compliance}}**: one badge per framework the workspace publishes, with the status it gives, such as "Certified" or "In progress". The status is whatever the workspace typed; Inflect does not work it out.
- **{{ui:external.trustCenter.securityPosture}}**: the workspace's own summary of how it protects data, as plain text.
- **{{ui:external.trustCenter.documents}}**: links to documents the workspace publishes, such as a security policy or a certificate. Each opens in a new tab, at the address the workspace gave.
- **{{ui:external.trustCenter.securityContact}}**: how to report a security problem or ask a question.
- At the bottom, the date the page was last changed.

The page shows no live data from the workspace: no controls, risks, findings or evidence. Everything on it was written for it on the settings page.

Search engines index the page only if the workspace allows it, with **{{ui:admin.trustCenter.allowIndexing}}**. Otherwise it is hidden from search results, though anyone with the address can still open it.

## What you can do

Visitors can read the page and follow its document links. There is nothing to sign in to or fill in.

To change the page, an Owner or Admin opens **{{ui:admin.trustCenter.title}}** in the admin settings, edits the content and saves; the public page shows the change straight away. An Owner publishes it with **{{ui:admin.trustCenter.publish}}** and can unpublish it the same way.

## What happens next

- Unpublishing makes the address show page-not-found again. Saved content is kept for when you publish again.
- The documents are links, not copies: if a linked file moves or is deleted where it is stored, the link on the page breaks.

## Empty and error states

| What a visitor sees | What it means | What to do |
| --- | --- | --- |
| Page not found | The trust center is not published, or the address is wrong | An Owner publishes it; check the address on the settings page |
| Only a name | The workspace published the page without filling anything in | Fill in the sections on the settings page |
