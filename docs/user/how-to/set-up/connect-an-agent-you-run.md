---
route: /t/[tenantSlug]/agents/[agentId]
---

# Connect an agent you run

Some agents run on your own machines, because they need your files, your network or your tools. Connect one of them to Inflect from its page in the agent register. Inflect creates a key for that agent and shows you what to paste into your agent's configuration. The agent then reads and proposes through Inflect, under the same controls as every other registered agent: its granted tools, its autonomy level, its kill switch and its audit trail.

There are two kinds of agent you can connect this way:

- an agent you wrote in code with Anthropic's Agent SDK, in TypeScript or Python;
- an agent you built in Anthropic's Console, called a Managed Agent there.

## Before you start

- You need the Owner or Admin role. Connecting creates an API key, and only those roles can create one.
- Register the agent first, score its risk assessment and activate it. Only an active agent can be connected.
- Grant the agent the tools it needs, on its **{{ui:admin.agentDetail.tabTools}}** tab. The key reaches those tools and no others, so an agent with no tools has nothing to connect.
- Have a safe place ready for the key, such as your agent's secret store. The full key is shown only once.

## Steps

1. Click **{{ui:nav.agents}}** in the sidebar, then click the agent in the register.
2. Click **{{ui:admin.agentDetail.connect.action}}** at the top of the agent's page. A panel opens.
3. In **{{ui:admin.agentDetail.connect.keyName}}**, keep the suggested name or type one that says where the agent runs.
4. In **{{ui:admin.agentDetail.connect.ceiling}}**, keep the agent's own level or choose a lower one. The key can never take the agent higher than its registered level.
5. Check **{{ui:admin.agentDetail.connect.scopes}}**. They are worked out from the agent's granted tools, and you do not choose them.
6. Click **{{ui:admin.agentDetail.connect.mint}}**.
7. The new key appears under the warning **{{ui:admin.agentDetail.connect.keyOnce}}** Click **{{ui:admin.agentDetail.connect.copyKey}}**, then store the key where your agent runs, as the environment variable `INFLECT_API_KEY`.
8. Choose the tab for your kind of agent and copy its configuration, as described below.
9. Click **{{ui:admin.agentDetail.connect.done}}**. The key is gone from the panel, and nobody can see it again.

### For an agent you wrote with the Agent SDK

Open the **{{ui:admin.agentDetail.connect.tabSdk}}** tab. It shows the options to add to your code, in TypeScript and in Python, and explains each line. Copy the block for your language into the place where your code starts the agent.

The options read the key from `INFLECT_API_KEY`, so the code you commit carries no key. They also list exactly the tools the agent is granted, turn off the built-in tools such as the shell, and stop settings files on the machine from adding anything. If your agent needs a built-in tool, add only that one.

### For an agent you built in Anthropic's Console

Open the **{{ui:admin.agentDetail.connect.tabConsole}}** tab. It shows three parts to paste into the Console:

1. **{{ui:admin.agentDetail.connect.console.server.title}}**: add it to the agent's MCP servers.
2. **{{ui:admin.agentDetail.connect.console.vault.title}}**: create it in a vault, and replace the placeholder with the key you copied. The key is kept in the vault, not in the agent.
3. **{{ui:admin.agentDetail.connect.console.toolset.title}}**: add it to the agent's tools. Every tool is off unless it is listed. Reads run on their own, and proposals ask before each call.

## What happens next

- The key appears on the **{{ui:admin.nav.apiKeys}}** page, bound to the agent, with the level you chose.
- Each call your agent makes is checked against the agent's grants, its autonomy level and its kill switch, and recorded in the workspace's audit log. A tool the agent is not granted is refused, whatever the key carries.
- If you stop the agent with its kill switch, or suspend it, the key stops working everywhere in Inflect until you lift the switch or activate the agent again.
- If you grant the agent more tools later, connect it again to get a key and a configuration that include them. Then revoke the old key on the **{{ui:admin.nav.apiKeys}}** page.

## If the panel explains instead of creating a key

The panel says why when it cannot create a key:

- you do not have the Owner or Admin role;
- you cannot read the agent's tools;
- the agent is not active;
- the agent has no granted tools.
