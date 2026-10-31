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
| Ask for a document on request | Anyone with the address |
| Add documents on request, and approve requests for them | Owners and Admins, on the **{{ui:admin.trustCenter.title}}** settings |
| Publish or unpublish it | Owners only |

## What it is for

Use it to answer the security questions every customer asks, once, in public: which standards you follow, how you protect their data, which documents they can read, and whom to contact. It saves sending the same answers in every questionnaire.

## What you see

Each part appears only when the workspace has filled it in:

- **The name and tagline** at the top: the display name the workspace chose, and an optional one-line description.
- **{{ui:external.trustCenter.compliance}}**: one badge per framework the workspace publishes, with the status it gives, such as "Certified" or "In progress". The status is whatever the workspace typed; Inflect does not work it out.
- **{{ui:external.trustCenter.securityPosture}}**: the workspace's own summary of how it protects data, as plain text.
- **{{ui:external.trustCenter.documents}}**: links to documents the workspace publishes, such as a security policy or a certificate. Each opens in a new tab, at the address the workspace gave.
- **{{ui:external.trustCenter.gated.title}}**: documents a visitor has to ask for, such as a SOC 2 report, listed by name only. Each has **{{ui:external.trustCenter.gated.request}}**.
- **{{ui:external.trustCenter.securityContact}}**: how to report a security problem or ask a question.
- At the bottom, the date the page was last changed.

The page shows no live data from the workspace: no controls, risks, findings or evidence. Everything on it was written for it on the settings page.

Search engines index the page only if the workspace allows it, with **{{ui:admin.trustCenter.allowIndexing}}**. Otherwise it is hidden from search results, though anyone with the address can still open it.

## What you can do

Visitors can read the page and follow its document links without signing in.

### Ask for a document on request

A visitor clicks **{{ui:external.trustCenter.gated.request}}** beside a document and fills in **{{ui:external.trustCenter.gated.name}}**, **{{ui:external.trustCenter.gated.email}}** and, if they like, **{{ui:external.trustCenter.gated.company}}**, then clicks **{{ui:external.trustCenter.gated.submit}}**. The page says: {{ui:external.trustCenter.gated.received}} It says the same whoever asks, so it reveals nothing about how the request is decided. Nothing opens until someone in the workspace approves it.

### Add documents on request, and approve requests

On the **{{ui:admin.trustCenter.title}}** settings, under **{{ui:admin.trustCenter.gated.title}}**, an Owner or Admin types **{{ui:admin.trustCenter.gated.labelField}}**, chooses the file and clicks **{{ui:admin.trustCenter.gated.upload}}**. The file is stored as an evidence record and scanned; it can be downloaded only once the scan passes. The trust center has to be saved once before documents can be added.

Requests appear under **{{ui:admin.trustCenter.gated.requestsTitle}}**, newest first, with who asked, for which document, and **{{ui:admin.trustCenter.gated.ndaAccepted}}** when they accepted the non-disclosure terms. Click **{{ui:admin.trustCenter.gated.approve}}** to create a download link. The link is shown once, with **{{ui:admin.trustCenter.gated.copyLink}}** and **{{ui:admin.trustCenter.gated.emailLink}}**: send it to the requester yourself. It works once and expires in 7 days, and the request then shows when it was downloaded or when the link expires.

To change the page itself, an Owner or Admin opens **{{ui:admin.trustCenter.title}}** in the admin settings, edits the content and saves; the public page shows the change straight away. An Owner publishes it with **{{ui:admin.trustCenter.publish}}** and can unpublish it the same way.


## What happens next

- Unpublishing makes the address show page-not-found again. Saved content is kept for when you publish again.
- The documents are links, not copies: if a linked file moves or is deleted where it is stored, the link on the page breaks.

## Empty and error states

| What a visitor sees | What it means | What to do |
| --- | --- | --- |
| Page not found | The trust center is not published, or the address is wrong | An Owner publishes it; check the address on the settings page |
| Only a name | The workspace published the page without filling anything in | Fill in the sections on the settings page |
| **{{ui:external.trustCenter.gated.unavailable}}** | The document is no longer offered: usually the trust center was unpublished while the visitor was asking | Nothing to do; ask the organisation through its security contact |
| **{{ui:external.trustCenter.gated.failed}}** | The request did not reach the server | Try again |
