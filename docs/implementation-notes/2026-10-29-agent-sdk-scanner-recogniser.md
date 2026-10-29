# 2026-10-29 — The scanner recognises Claude Agent SDK agents (Claude agents 3b)

**Commit:** `<sha> feat(agent-harness-scanner): recognise Claude Agent SDK agents in code, and report their options as ladder verdicts (Claude agents 3b)`

Step 3b of `docs/claude-agent-sdk-design.md` (#4156). An agent a customer
builds on the Agent SDK and runs themselves now shows up in the register's
harness view, as shadow or registered, like a LangGraph one.

## Design

```
files.ts      a file is parsed only if it names a framework module (FRAMEWORK_MARKERS)
python.ts     for / async for: the iterable is read, so `async for m in query(...)` is a call
recognize.ts  sdkAgents(): query / ClaudeSDKClient resolved through the file's imports,
              and a Python ClaudeAgentOptions no such call consumes
                  └─ sdkAgent(): tools, model, credentials, and AgentSdkOptionFacts
langchain.ts  observationOf(): verdicts = agentSdkOptionVerdicts(facts)
                                         └─ harness-findings.ts: AGENT_SDK_OPTION_CRITERIA
report.ts     collapses each agent's verdicts per criterion, as before
ingest        unchanged: /3 carries verdicts already
```

## Files

| File | Role |
| --- | --- |
| `packages/agent-harness-scanner/src/sources/code/recognize.ts` | the SDK agents and their options |
| `packages/agent-harness-scanner/src/sources/code/ir.ts` | `isClaudeAgentSdkModule` |
| `packages/agent-harness-scanner/src/sources/code/files.ts` | `FRAMEWORK_MARKERS`: the SDK's module names let a file through |
| `packages/agent-harness-scanner/src/sources/code/python.ts` | a `for` statement's iterable is read |
| `packages/agent-harness-scanner/src/sources/langchain.ts` | an SDK agent's observation carries its option verdicts |
| `src/lib/agentic/harness-findings.ts` | `AgentSdkOptionFacts`, `AGENT_SDK_OPTION_CRITERIA`, `agentSdkOptionVerdicts` |
| `src/lib/agentic/harness-contract-rules.ts` | `looksLikeSecret` knows Anthropic's key shape |
| `tests/helpers/agent-harness-code-fixtures.ts` | SDK fixtures in both languages, the unresolved shapes, the lookalikes |
| `tests/helpers/agent-harness-fake-scanner.ts` | `validV3ReportBodyWithSdkAgent`, the reference |

## Decisions

- **The mapping runs in the scanner, from a table in the planner module.** The
  step asked for the mapping "in the pure planner", and for a stop if the report
  needed a new member. The planner sees only the report, and `/3` has no member
  for SDK options, but it does carry verdicts. So `harness-findings.ts` holds
  the owner's table and the function. The scanner, which may import that
  module, applies it, and the ingest receives ordinary verdicts. The contract
  is unchanged.
- **Four of five mappings were owner decisions** (2026-10-29, recorded on
  #4156). A wildcard in `allowedTools` fits `H2.tools_allowlisted` directly.
  The other four were asked:
  - `bypassPermissions` fails `H3.propose_not_commit`.
  - Host settings loaded fail `H3.skills_declared` and `H2.tools_allowlisted`.
  - A callable `Bash` or `WebFetch` fails `H2.tools_allowlisted`.
  - No hook fails `H3.payloads_guarded`, only when `settingSources` is `[]`.
- **NOT MET only.** A hook that is present is no evidence that it guards
  anything, and a hardened agent raises no verdict at all, not a MET one.
- **An unread option is null, never the default.** Options passed in from a
  parameter, `**kwargs`, a spread or a computed list leave the affected facts
  `null`. Treating them as the SDK's permissive defaults would raise findings
  the code does not support.
- **`tools` left out means every built-in**, as the design doc records the
  SDK's documented defaults (2026-10-24). `allowedTools` auto-approves and does
  not restrict, so its built-in names add a tool only when the built-in list
  could not be read. Its `mcp__<server>__<tool>` names are attributed to a
  configured server, and a name on a server the options do not configure is
  unresolved: it comes from settings the reader cannot see.
- **`subagents` is read and mapped to nothing.** The owner's list did not
  include delegation, and `H3.delegation_narrows` is not to be inferred
  without asking.
- **Two fixes outside the recogniser, each needed for the step to hold:**
  - **The text prefilter.** It passed only files naming `langchain` or
    `langgraph`, so an SDK-only repository was never parsed.
  - **The Python reader.** It dropped the operand of `in`, so
    `async for message in query(...)`, the SDK's documented Python usage, had
    no call.
- **`looksLikeSecret` gains `sk-ant-…`.** The `sk-` rule stopped at the hyphen,
  so the ingest's last check would have accepted an Anthropic key: the
  credential an SDK agent is most likely to have written into it. The
  repository's own `.secret-patterns` already knew the shape.
