---
route: /t/[tenantSlug]/agents/decisions
---

# {{ui:agents.decisions.title}}

The {{ui:agents.decisions.title}} lists the model calls this workspace has made. Each entry records which feature called a model, a short summary of the answer, and whether a person has reviewed the outcome. It is the record an assessor asks for under the EU AI Act: what an AI system decided, and whether a human looked.

## Where to find it

Open **{{ui:nav.agents}}** under **{{ui:nav.manage}}** in the sidebar, then choose **{{ui:common.ui.viewsMenu}}** › **{{ui:agents.views.decisions}}**.

On an agent run's own page, a model-call step that produced a decision has a **{{ui:agents.runs.detail.decisionLink}}** link. It opens this page showing only the decisions made over that step's content.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the log | Owner, Admin, AI admin |

Everyone else, Auditors included, sees **{{ui:agents.register.accessTitle}}** instead of the page.

## What you see

The newest 100 model calls, newest first. Each entry shows:

- **The review outcome**, as a coloured label:

  | Label | What it means |
  | --- | --- |
  | **{{ui:agents.decisions.outcome.PENDING}}** | No person has decided on this outcome yet |
  | **{{ui:agents.decisions.outcome.ACCEPTED}}** | A person accepted what the model produced |
  | **{{ui:agents.decisions.outcome.EDITED}}** | A person accepted it after changing it |
  | **{{ui:agents.decisions.outcome.REJECTED}}** | A person rejected it |
  | **{{ui:agents.decisions.outcome.AUTONOMOUS}}** | The outcome went ahead with nobody in the loop, because an Owner set that change to run automatically |

- **The feature** that called the model, such as the assistant, risk suggestions or an agent workflow.
- **The provider and model** it called.
- **What the output guard found**, when it checked the answer.
- **When** the call was made.
- **A short summary** of the answer, when one was recorded. It is a bounded, cleaned summary, not the full model output.
- **Tokens in and out**, and how long the call took, when they were reported.
- **A fingerprint** of the input: the first characters of a code computed from what the model was sent. The content itself is never stored here.

## What you can do

Read. The page changes nothing. A review outcome is recorded where the decision is made, such as approving or rejecting a proposal in the [{{ui:agents.proposals.title}}](agent-proposals.md) queue.

**See the decisions over one piece of content.** Follow a **{{ui:agents.runs.detail.decisionLink}}** link from a run's step. The page then says it is showing decisions over one piece of content, and lists only those. To see every decision again, open **{{ui:agents.views.decisions}}** from the views menu.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:agents.decisions.emptyTitle}}** | {{ui:agents.decisions.emptyDesc}} Nothing has called a model yet | Nothing to do |
| **{{ui:agents.decisions.emptyFilteredTitle}}** | {{ui:agents.decisions.emptyFilteredDesc}} | Open the full log from the views menu |
| **{{ui:agents.register.accessTitle}}** | Your role cannot open the log | Ask an Owner |

## Related

- [{{ui:agents.runs.title}}](agent-runs.md), the agent runs whose model calls appear here.
- [Agent run](agent-run-detail.md), where a model-call step links to its decision.
- [{{ui:agents.proposals.title}}](agent-proposals.md), where proposals are approved or rejected.
