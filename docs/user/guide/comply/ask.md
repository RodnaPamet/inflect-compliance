---
route: /t/[tenantSlug]/agents/ask
---

# {{ui:agents.ask.title}}

On the {{ui:agents.ask.title}} page you type a question in plain words, and an AI agent answers it from this workspace's own records. The page lists every record lookup the agent made, so you can see what the answer is based on.

## Where to find it

Open **{{ui:nav.agentsAsk}}** under **{{ui:nav.comply}}** in the sidebar.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page and ask a question | Owner, Admin, Editor, Reader, Auditor and AI admin |
| Read an answer | Only the person who asked |

The page and its answers need read access to the workspace's controls, which every built-in role has. If your workspace uses custom roles, the page follows your custom role's own permission to read controls; without it, the page reads **{{ui:agents.ask.accessTitle}}**.

The agent reads as you. It can reach only records you could open yourself, and it can only read: it cannot change, create or propose anything.

## What it is for

Use it for questions that would otherwise take several pages to answer, such as which controls have no evidence this quarter, or which risks are past their review date. Check the answer against the records it lists before you rely on it.

## What you see

**The question box.** It reads **{{ui:agents.ask.inputLabel}}**, with an example question until you type. Under it, a counter shows how many characters you have used. A question can be up to 2,000 characters.

**The answer.** After you ask, the page shows one of these:

- **{{ui:agents.ask.answerHeading}}**, with the agent's answer as plain text.
- **{{ui:agents.ask.noAnswerTitle}}**, when the agent finished without writing one.
- **{{ui:agents.ask.emptyCatalogueTitle}}**, when the agent was given no tools to read records with. Nothing it could say would be based on your records, so the page shows no answer.

**{{ui:agents.ask.callsHeading}}.** Below the answer, always open: every lookup the agent made, in order. Each row shows its number, the name of the tool the agent used, and its outcome, such as DONE. A refused lookup also shows the code of the reason it was refused, and a lookup the workspace's AI safeguards flagged shows their verdict. When the agent looked nothing up, the list reads **{{ui:agents.ask.noCalls}}**

**The run's details.** At the bottom:

| Detail | What it shows |
| --- | --- |
| {{ui:agents.ask.model}} | The AI model that answered, or **{{ui:agents.ask.noModel}}** when no model was used |
| {{ui:agents.ask.tokens}} | How much model capacity the answer used |
| {{ui:agents.ask.status}} | How the run ended, as a code such as COMPLETED or FAILED |

## What you can do

### Ask a question

Type your question and click **{{ui:agents.ask.ask}}**. The button reads **{{ui:agents.ask.asking}}** while the agent works, and the box is locked. At first the page shows **{{ui:agents.ask.runningTitle}}**; that message goes once the agent has started, while the page keeps waiting for the answer.

The page waits about two minutes. If the agent has not finished by then, it stops waiting and says so. The agent may still finish, but this page cannot show you its answer afterwards; ask again if you need it.

You can ask up to 20 questions an hour. Each question starts fresh: the agent does not remember your earlier questions, and the page keeps no history of them. Leaving the page drops the answer on screen.

## What happens next

- Each question is a run of the workspace's chosen agent, and it appears on the [agent runs](../manage/agent-runs.md) page, which Owners, Admins, AI admins and Auditors can open.
- The tokens it used count towards the agent's monthly budget.
- Nothing in the workspace changes. The agent only reads.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:agents.ask.accessTitle}}** | Your role cannot read controls | Ask an Owner or Admin for access |
| **{{ui:agents.ask.refusedBadge}}**, with a reason | The question was not run. The reason says why: for example, the question was empty or too long, or the workspace has no agent chosen to answer questions, or that agent has been stopped | For a question problem, change the question and ask again. For anything about the agent, ask an Owner or Admin |
| **{{ui:agents.ask.refusedBadge}}** and **{{ui:agents.ask.refusedUnknown}}** | The question was refused without a reason | Try again; if it keeps happening, ask an Owner or Admin |
| The counter turns red, with a message that the question is too long | The question is over 2,000 characters, and **{{ui:agents.ask.ask}}** stays unavailable | Shorten it |
| **{{ui:agents.ask.timedOut}}** | The page stopped waiting after about two minutes | Ask again, or ask an Owner, Admin, AI admin or Auditor to look it up on the agent runs page |
| **{{ui:agents.ask.noAnswerTitle}}** | The agent finished without an answer | Read the lookups it made, then rephrase and ask again |
| **{{ui:agents.ask.emptyCatalogueTitle}}** | The agent has no tools to read records with | Ask an Owner, Admin or AI admin to give it tools |

## Related

- [{{ui:agents.register.title}}](../manage/agents.md), where the workspace's agents are registered.
- [{{ui:controls.title}}](../govern/controls.md), [{{ui:risks.title}}](../govern/risks.md) and [{{ui:evidence.title}}](evidence.md), the records most questions are about.
