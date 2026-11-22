# 2026-11-22 — Step 3H: the Phase 3 proving run

**Commit:** _(this PR)_ `docs(agents): Step 3H evidence — a wizard-connected Agent SDK program, held to its grants`

## Design

Step 3H asks for evidence, from production, that an agent a customer runs and
connects through the wizard is bounded by the register. The code half (the
adversarial read of 3a and 3b, the retirement cascade test and the proving
program) merged in #4540. This note records the run itself.

```
Cloud Shell (owner)                 this session                     app.inflect.bg (proving tenant)
-------------------                 ------------                     -------------------------------
agent.ts = wizard options  ──────────────────────────────────────▶  /api/mcp  list_risks    → MCP_TOOL_INVOKED ×2
call-ungranted list_controls ────────────────────────────────────▶  /api/mcp  list_controls → AUTHZ_DENIED
                                    scanent `code` source over the
                                    same agent.ts, signed report ──▶  harness ingest → scan, SHADOW agent
```

The ids are in the Phase 3 row of "Operational evidence" in
`docs/claude-agent-sdk-design.md`.

## Files

| File | Role |
| --- | --- |
| `docs/claude-agent-sdk-design.md` | The Phase 3 evidence row; a sentence in Current state that a wizard-connected program has run |
| `docs/claude-managed-agents-design.md` | Current state: shape MA-B is offered and has not been exercised |
| `scripts/agent-sdk-proving-run/README.md` | The audit actions to look for, where row ids are read, and that the scanner is scanent |

## Decisions

- **The keys never touched this session.** The Anthropic key and the wizard
  key were typed at hidden prompts in the owner's Google Cloud Shell. Anthropic's
  hosts take no credential through this session's environment, and the wizard
  key is shown once to the person who mints it.
- **The scan ran from this session, not the owner's shell.** After #5684 the
  scanner is scanent, a Node program, so this session built it and ran its
  `code` source over a copy of the proving folder. The signing key was generated
  here and only its public half left; the ingest key was used once and deleted.
- **The scanned `agent.ts` was rendered by the wizard's own function**
  (`agentSdkTypeScript` with the production origin and the agent's grant), not
  copied by hand. The snippet takes only the origin and the granted tools, so
  this is byte-identical to what the owner pasted.
- **The roadmap's "`TOOL_CALL` audit row" is `MCP_TOOL_INVOKED`.** `TOOL_CALL`
  is the `WorkflowStep` kind of Inflect-hosted runs; `/api/mcp` audits a granted
  call under its own action. The evidence row says so instead of renaming
  anything.
- **No Managed Agent run.** The owner chose to record its absence (2026-11-22).
  Phase 5 builds and proves the Managed Agent path in the customer's workspace.
- **Two findings came out of reading the run's rows**, and neither is fixed
  here: the scan's ingest is audited as `USER` though a key posted it (#5786),
  and scanent reports the MCP server's whole surface for an agent whose
  `allowedTools` restricts it under `permissionMode: "dontAsk"` (reported to
  scanent).
