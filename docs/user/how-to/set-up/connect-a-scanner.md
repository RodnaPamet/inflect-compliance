---
route: /t/[tenantSlug]/agents/reports
---

# Connect a scanner

scanent is the scanner that runs in your own estate and finds the agents, the applications and the agent tools your directories and code hold. It works on its own, writing its results to a folder. Connect it to Inflect and its reports appear on the agent reports page instead: the agents on **{{ui:agents.reports.tabHarness}}**, the applications on **{{ui:agents.reports.tabIntegrations}}** and the rules that fired on **{{ui:agents.reports.tabAgentSurface}}**.

One panel does the Inflect half. It registers the scanner's public key, creates one API key for every report you choose, and shows what to put into the scanner's two files.

## Before you start

- You need the Owner or Admin role. Connecting creates an API key, and only those roles can create one.
- Register an agent for the scanner in the agent register, score its risk assessment and activate it. Only an active agent can hold a key, and its key stops working if the agent is suspended or stopped.
- Run `scanent init` where the scanner will run. It writes the scanner's configuration and its signing key.
- Print the scanner's public key with `scanent public-key`, and keep it to paste.
- Have a safe place ready for the key, such as the scanner's secret store. The full key is shown only once.

## Steps

1. Click **{{ui:nav.agents}}** in the sidebar, then open the agent reports and the **{{ui:agents.reports.tabHarness}}** tab.
2. In **{{ui:agents.harness.keys.heading}}**, click **{{ui:agents.harness.connect.open}}**. A panel opens.
3. In **{{ui:agents.harness.connect.agentLabel}}**, choose the scanner's agent. If it is not active yet, the panel says what is missing and links to the agent.
4. In **{{ui:agents.harness.connect.publicKeyLabel}}**, paste what `scanent public-key` printed. If the agent already has a key registered, you can leave this empty.
5. Under **{{ui:agents.harness.connect.reportsLabel}}**, tick the reports the scanner makes. Tick the integrations report if the scanner reads your directories' applications, and the agent-surface report if it reads MCP servers or agent code.
6. To let the scanner check its findings against the agent register, tick the last box. This grants the scanner's agent the tool it reads the register with. You see the box only if you can grant tools.
7. Keep the suggested key name or type one, and check the scopes. They follow from what you ticked.
8. Click **{{ui:agents.harness.connect.submit}}**.
9. The new key appears under the warning **{{ui:agents.harness.connect.keyOnce}}** Click **{{ui:agents.harness.connect.copyKey}}**.
10. Under **{{ui:agents.harness.connect.envHeading}}**, copy the lines into the scanner's `scanent.env` and paste the key after each `=`. It is the same key on every line.
11. Under **{{ui:agents.harness.connect.configHeading}}**, copy the block and merge it into the scanner's `config.json`, as the panel describes.
12. Click **{{ui:agents.harness.connect.done}}**. The key is gone from the panel, and nobody can see it again.

Then run `scanent doctor` where the scanner runs. It checks the key against your workspace before the first scan.

## What happens next

- The key appears on the **{{ui:admin.nav.apiKeys}}** page, bound to the scanner's agent.
- After the scanner's next scan, its reports appear on their tabs. A report is accepted only when the key it was signed with is registered for the scanner's agent.
- To post another report later, connect the scanner again with that report ticked, put the new key in the scanner's files, and revoke the old key on the **{{ui:admin.nav.apiKeys}}** page.

## If the panel explains instead of connecting

The panel says why when it cannot connect a scanner:

- you do not have the Owner or Admin role;
- no agent in the register can be a scanner yet;
- the agent you chose is not active.

If a step is refused, the panel names the step and shows the reason. Steps that worked are not repeated when you try again.
