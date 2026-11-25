---
route: /t/[tenantSlug]/agents/reports
---

# Connect a prober

A prober sends fixed attacker probes to your agents during an engagement you approved, and reports what each agent did: whether it followed an injected instruction, disclosed something it should not have, or resisted. Connect it to Inflect and its runs appear on the agent reports page, on the **{{ui:agents.reports.tabProbes}}** tab, with a finding for every agent that acted or disclosed.

Two kinds of key make a report count:

- a **prober key**, which the prober signs its report with;
- an **approver key**, which signs the engagement's scope: the agents the prober may probe, and when.

A report is accepted only when both are registered here. A key can be one or the other, never both: whoever runs the probes does not also approve them.

## Before you start

- Register an agent for the prober in the agent register. A prober key belongs to that agent, and a retired agent cannot hold one.
- Have the prober's public key ready to paste, and the public key of whoever approves engagements.
- To register a prober key you need to manage the agent register. To register an approver key you need the Owner role.

## Steps

1. Click **{{ui:nav.agents}}** in the sidebar, then open the agent reports and the **{{ui:agents.reports.tabProbes}}** tab.
2. In **{{ui:agents.reports.probes.proberKeys.heading}}**, click **{{ui:agents.reports.probes.proberKeys.register}}**.
3. Choose the prober's agent, paste its public key and click **{{ui:agents.reports.probes.registerModal.submit}}**.
4. As an Owner, in **{{ui:agents.reports.probes.approverKeys.heading}}**, click **{{ui:agents.reports.probes.approverKeys.register}}**.
5. Say who holds the approver key, paste its public key and click **{{ui:agents.reports.probes.registerModal.submit}}**.
6. On the **{{ui:admin.nav.apiKeys}}** page, create an API key with the `admin:agent_probes_ingest` scope for whoever sends the prober's reports. The full key is shown only once.

## What happens next

- Each report sent with that API key appears on the **{{ui:agents.reports.tabProbes}}** tab, under the prober that signed it.
- Click a run to see every probe's verdict, agent by agent. If you manage the agent register, you also see what each agent replied and the agent's full address; anybody else sees that they were withheld.
- An agent that acted or disclosed raises a finding in the findings register. It closes when the same prober sends the same probe to the same agent again and the agent resists. A probe that got no answer closes nothing.

## If a report is refused

A report is refused, and nothing from it is kept, when:

- it was not signed by a prober key registered here;
- its engagement was not approved by an approver key registered here, or that key was revoked before the report arrived;
- the same report was sent before.

Revoking a prober key or an approver key refuses every later report it signed or approved. The runs already accepted stay.
