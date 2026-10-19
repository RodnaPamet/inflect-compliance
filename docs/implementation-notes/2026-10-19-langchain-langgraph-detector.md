# 2026-10-19 — The LangChain and LangGraph detector (the scanner's `code` source)

**Commit:** `feat(agentic): a LangChain and LangGraph detector in the reference harness scanner (#3737)`

A Phase 4 follow-up of step 4a (#3678, Phase 4 #3659), on the contract bump
#3754. Owner decision, 2026-10-19: LangChain-built agents are governed as things
the product discovers; LangChain is not a dependency of the platform or of the
scanner. The detector reads an estate's code and reports each agent definition
through `inflect-agent-harness/2`, with no change beyond #3754.

## Design

```
roots (label, absolute path)
   │  files.ts — lstat/readdir/readFile only; sorted walk; caps; no symlinks;
   │             skips dependency and build directories; prefilter on the
   │             words "langchain" / "langgraph"
   ▼
.py ──► python.ts      bounded tokenizer + expression reader ─┐
.js/.ts/… ──► javascript.ts  TypeScript syntax-only parser ────┤──► FileFacts (ir.ts)
                                                               │    imports, bindings,
                                                               │    tool declarations, calls
                                                               ▼
                                         recognize.ts — one recogniser for both
                                         languages: names resolved through the file's
                                         imports; factories, executors (absorbing the
                                         factory they wrap), compiled StateGraphs;
                                         tools, models + endpoints, credentials by
                                         reference; anything unresolved → its line
                                                               │
                                                               ▼
              sources/langchain.ts — HarnessSource `code`: DetectedAgent → Observation;
              problems → INCOMPLETE with the first reason in
              AUTH_FAILED > UNREACHABLE > TIME_BOX > BYTE_CAP > UNPARSEABLE
```

## Files

| File | Role |
|---|---|
| `packages/agent-harness-scanner/src/sources/code/ir.ts` | The expression IR both readers lower to, and `FileFacts` |
| `packages/agent-harness-scanner/src/sources/code/python.ts` | Python tokenizer and expression reader |
| `packages/agent-harness-scanner/src/sources/code/javascript.ts` | JavaScript/TypeScript through `ts.createSourceFile` |
| `packages/agent-harness-scanner/src/sources/code/recognize.ts` | Agents, tools, models, endpoints, credentials; what did not resolve |
| `packages/agent-harness-scanner/src/sources/code/files.ts` | The bounded, read-only walk and its problems |
| `packages/agent-harness-scanner/src/sources/langchain.ts` | The `code` source behind the existing interface |
| `packages/agent-harness-scanner/src/{source,report,scan,config,scanner-surface,index}.ts` | `Observation.tools`, `SourceContext.deadline/now`, tool merging and its cap, the `code` config, the declared file reads, version `0.3.0` |
| `eslint.config.mjs` | No subprocess, VM, module loader, `require`, `import()` or `eval` in the source's files; two shared consts so the new block does not drop the package's or the platform's rules |
| `tests/helpers/agent-harness-code-fixtures.ts` | The LangChain Python, LangChain JS and LangGraph estates, and the ones that must not read clean |

## Decisions

- **Parsers.** TypeScript's own parser for JS and TS: already a dependency,
  syntax-only, no program or resolution. For Python a bounded lexical reader
  rather than a WebAssembly grammar (a new dependency and its supply chain) or a
  Python subprocess (an interpreter, and the scanned repository's
  `sitecustomize`/`.pth`, one flag from running client code). LangChain
  definitions are imports, assignments and calls with keyword arguments; the
  reader gets strings, comments and brackets exactly right and turns everything
  else into `opaque`, which the recogniser reports as `UNPARSEABLE` where it
  matters. No new npm dependency.
- **Resolution, not spelling.** A call counts only when its name resolves
  through the file's imports to a `langchain`/`langgraph` module, so a local
  `create_react_agent` is not LangGraph's (fixture `lookalike`).
- **One agent per definition.** An `AgentExecutor` absorbs the factory it wraps.
  A compiled `StateGraph` is an agent only when it has a `ToolNode` or a model
  bound to tools: a graph of plain functions is a workflow.
- **The agent's name is the variable it is bound to**, not its line, so the
  `discoveredId` survives an edit above it. Two in one file with the same name
  fall back to `name@L<line>`.
- **Credentials by reference.** `env://NAME`, a provider's or tool's documented
  default variable when none is passed (basis `provider-default`), or
  `code://<label>/<path>#L<line>` for a literal. The literal stays a token in the
  parser's memory; nothing that leaves the source holds it. The absolute root
  path never leaves either: only the label.
- **Fail closed.** A tool list returned by a function, a model passed as a
  parameter, `**kwargs`, a credential read from a settings object, a file that
  does not parse: `UNPARSEABLE`, with the agent still reported. A symbolic link
  is not followed and is a location not read (`UNREACHABLE`), because following
  it could leave the root or loop, and skipping it silently would describe a
  smaller tree than the one configured.
- **No unbound credentials from code.** A reference in code that no agent uses
  is not evidence that a credential exists, so the source returns none and
  raises no `ORPHAN_CREDENTIAL`.
- **Model endpoints go into `/2`'s optional `models[]`** (owner decision,
  2026-10-19, recorded on #3754): an https URL, an `env://` reference, or — for
  a model whose endpoint is not knowable statically, such as a bare model id
  with no provider — the `code://` locator of its construction, never nothing.
  The ingest verifies them and stores none.
- **The manifest declares the file reads.** No request is made, but reading code
  is a capability, so `SCANNER_SURFACE.readsFiles` names it and the hash moves.
