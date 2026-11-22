# 2026-11-22 — A policy card can permit the agent's granted external tools

**Commit:** `fix(agents): a policy card can permit the agent's granted external tools (#3752)`

## Design

Found in the A2A production pilot: an Invoke-agent run settled "no tools", its
A2A send withheld as "not permitted by its policy card". The boundary
(`evaluateCardReach`) holds every tool call, external ones included, to the
card's `permittedTools`, but nothing could put an external name there:

- the editor offered only `MCP_TOOL_NAMES`;
- `withholdingReasonForTool` answered `NOT_IN_CATALOGUE` for any name not in
  that list, and `assertDeclarationsExercisable` refused the save on it;
- seeding withheld every external grant for the same reason.

So no agent with a policy card could call any external tool: a tool server's
tool or an A2A send.

Now:

| Where | Change |
| --- | --- |
| `withholdingReasonForTool` | A well-formed external name (`parseExternalToolName`) is judged by its ceilings: rung 2 (what `external-tools.ts` declares) and `EXTERNAL_EGRESS` (what `baseDataScopeForTool` answers) |
| `updateAgentPolicyCard` | An edit may ADD an external name only if the agent holds that grant |
| `getAgentPolicyCard` | Returns `permittableExternalTools` (granted external tools, labelled with the connection's name) to a caller who may edit the card; `null` to anybody else |
| `PolicyCardTab` | Lists them under "External tools", through the same checkbox and the same exercisability predicate as a built-in tool |

## Decisions

- **The grant bounds an external name.** A built-in name is bounded by the
  catalogue; an external one is free text, so the writer refuses one the agent
  is not granted. Only ADDED names are asked: a stored name whose grant has since
  gone never blocks an unrelated edit, and dropping one is a free narrowing.
- **Writers only.** Grants otherwise sit behind `admin.agent_tool_exposure`; the
  list is sent only to a caller who passes the card's own write floor, who is
  the only one shown the editor.
- **Seeding follows the same predicate.** A new card for an agent already
  granted an external tool and declared `EXTERNAL_EGRESS` within its tier's
  autonomy now permits it, as it does any built-in grant within its ceilings;
  otherwise it names the real ceiling instead of NOT_IN_CATALOGUE.
