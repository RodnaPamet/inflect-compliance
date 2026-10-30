# Agent SDK proving run (Step 3H)

The evidence Step 3H of `docs/claude-agent-sdk-design.md` asks for: an agent
built on Anthropic's Agent SDK, configured with **exactly** what the connect
wizard generates, connected to a proving tenant through a key the wizard minted.
It calls one granted read tool, and one ungranted tool is called with its key.

This folder is self-contained and outside the application's build: it has its
own `package.json` and is excluded from the root typecheck and lint.

## Run it

1. On the agent's page in the proving tenant, open **Connect an agent you run**,
   mint the key, and copy the **Agent SDK → TypeScript** snippet into `agent.ts`
   here. Keep the key in the sheet open; you paste it at a prompt below.
2. `npm install`
3. `npm run agent`. It asks for the wizard's key and an Anthropic API key at
   hidden prompts. The snippet's prompt asks for the open risks, so the agent
   calls the granted `list_risks`; the result message is printed.
4. `npm run ungranted -- https://<origin> list_controls`. It asks for the
   wizard's key and calls a tool the agent is not granted. Expect a JSON-RPC
   error, `answered: false`.

Then point the harness scanner's `code` source at this folder (it reads files,
and runs nothing) and record the `DiscoveredAgent` id it reports.

Keys are read from hidden prompts only. `agent.ts`, `node_modules` and the lock
file are ignored by git.
