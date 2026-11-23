# Sub-processor notice — Anthropic, hosted agents (Claude Managed Agents)

<!-- The filename carries 2026-11-23, the date this was DRAFTED. It is not the
     issue date. The issue date below is the authoritative one, and it stays
     OPEN until the notice is actually posted and emailed. -->

> **DRAFT — NOT ISSUED.** This notice has not been posted or sent to anyone.
> It is issued only after the repo owner has recorded the compliance approval on
> its pull request, and the data processing agreement, the transfer mechanism
> and the decision on a transfer impact assessment on #5865, and has filled in
> the dates below.

**Issued:** OPEN — the date the notice is posted and emailed, entered by the repo owner.
**Objection window closes:** OPEN — 30 days after the issue date, entered by the repo owner.

---

## What is changing

Inflect proposes to offer **hosted agents**: an agent you set up in Inflect
runs on Anthropic's Claude Managed Agents service, inside **Inflect's own**
Anthropic account, for a workspace that has no Anthropic account of its own.
Anthropic is already one of our sub-processors for AI features. This is new
processing by it, because Anthropic **stores** a record of each agent run,
where our other AI features only send a request and receive an answer.

## Is it on for you?

**No, unless you turn it on.** Hosting is off for every workspace. Only an
Owner of your workspace can turn it on for that workspace. **If your workspace
does not opt in, nothing of yours is sent to or stored in Inflect's Anthropic
account.** A workspace whose AI processing is set to local only cannot use it.

## What is stored, where, and for how long

For a workspace that opts in, each agent run stores at Anthropic:

- the agent's instructions, as your workspace wrote them, with Inflect's own
  fixed instructions and the list of skills the agent may use;
- the task the run was given and its input;
- what the agent's model wrote and the tools it called;
- everything Inflect's tools returned to it. This is data from your workspace
  that the agent is allowed to read — for example risks, controls and tasks,
  including the names and work email addresses of their owners and assignees;
- internal ids of your workspace and of the run, never their names.

**Where:** stored in the **United States**. Anthropic offers no other storage
region for this service. The model itself may run in any of Anthropic's
regions, as it does for Inflect's other AI features.

**For how long:** Inflect deletes the run's record **as soon as the run ends**.
If a deletion fails, Inflect records the failure, and the record stays at
Anthropic until Inflect's clean-up deletes it. Anthropic does not offer zero
data retention for this service. Anthropic states that it may
keep data where the law requires, and may keep the inputs and outputs of a run
its safety systems flag for up to two years.

**Kept permanently:** Anthropic does not allow an agent's configuration to be
deleted, only archived. So the configuration of each agent stays at Anthropic.
It contains **only Inflect's own fixed instructions, the descriptions of
Inflect's tools, the model it uses and an internal id** — never your instructions, your data, or
your workspace's name.

## Who at Inflect can see it

While a run's record exists, it can be viewed in Anthropic's console by the
members of Inflect's Anthropic account who hold the **Developer** or **Admin**
role. Inflect's application reads it to run your agent, with a key held in
Inflect's production configuration.

## Your right to object

You may object on reasonable data-protection grounds until the window closes
(date above). Write to **OPEN — the objection address, named by the repo owner
before issue**, or to the contact on your contract.

Objecting costs you nothing: hosting is off unless your workspace turns it on,
and every other part of Inflect works without it.

## Where to read more

- The sub-processor list: `docs/sub-processors.md`, Anthropic, entry (g).
- The design: `docs/claude-managed-agents-design.md`, section "MA-C1".
