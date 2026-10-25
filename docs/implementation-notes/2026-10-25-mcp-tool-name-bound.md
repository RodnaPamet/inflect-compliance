# 2026-10-25 — External MCP tool names are bounded where they enter

**Commit:** `fix(mcp): refuse an external tool name past the MCP limit where the catalogue is read (#4238)`

## Design

An external MCP server's advertised tool NAME was unbounded text from another
party. Two caps already existed. `MAX_TOOLS_PER_CONNECTION` (250) bounds how many
tools are read, and the 1 MB response cap bounds the whole reply. Neither bounds
one name. Since #4210 every name reaching the AI Guard is resolved rather than
caller-invented, but an external tool's resolved name is still someone else's
text. It became the qualified name everywhere downstream, including
`mcpArgumentSource`, the `source` of a hash-chained `AI_GUARD_EGRESS_*` audit row
that streams to the tenant's SIEM.

The owner chose to bound it AT THE READER (2026-10-25): `listTools` in
`app-layer/integrations/mcp/client.ts`, the one place every advertised name
enters.

```
tools/list reply
  each descriptor: name a string of 1..128 UTF-16 units?
    yes -> kept, in the server's order
    no  -> refused, counted
  -> { tools, refusedNames }
       catalogue  -> refusedNames shown to the operator as a count
       runtime    -> logged per connection (mcp.external_tool_names_refused)
       Test button -> ignored; reachability is its only question
```

128 is the MCP specification's own figure (2025-11-25, "Tool Names": names
SHOULD be between 1 and 128 characters).

## Files

| File | Role |
|---|---|
| `src/lib/mcp/external-tool-name.ts` | `MCP_TOOL_NAME_MAX_LENGTH`, in a module with no imports so the page can quote it |
| `src/app-layer/integrations/mcp/client.ts` | `listTools` refuses unusable names and returns `{ tools, refusedNames }` |
| `src/app-layer/usecases/external-mcp-tools.ts` | Catalogue carries `refusedNames`; the runtime read logs it per connection |
| `src/app/t/[tenantSlug]/(app)/agents/external-tools/ExternalToolsClient.tsx`, `messages/{en,bg}.json` | One sentence saying how many tools were left out, and why |

## Decisions

- **Refuse, never truncate.** Two long names sharing a 128-character prefix
  would truncate to one name, and a pin or grant keyed on it would belong to
  whichever tool came first.
- **At the reader, not per consumer.** Bounding only the audit source would
  leave the pin, grant rows, policy card and `tools/list` to the model carrying
  the long name. The reader is the one place all of them come from.
- **Counted, never quoted.** A refused name is the text this exists to keep out
  of logs, audit rows and screens, so the operator sees a count and the reason.
- **Length only.** The specification also recommends a character set
  (`A-Z a-z 0-9 _ - .`). That is a separate decision with a wider blast radius,
  because real servers may already use names outside it. It is not taken here.
- **A tool already pinned under a longer name** becomes unreachable at the next
  read. The runtime log line is the trace. No such pin is known to exist.
