# 2026-10-29 — The Anthropic SDK, and one place to build its client (Claude agents 2a)

**Commit:** `<sha> feat(agentic): add the Anthropic SDK and clientForRun, the one place an agent run's client is built (Claude agents 2a)`

Step 2a of the roadmap in `docs/claude-tool-runner-design.md` (#4148). It adds
`@anthropic-ai/sdk` 1.3.0 as a direct dependency and `clientForRun`, the only
function that builds an Anthropic client for an agent run. Nothing calls it yet
outside its tests. The driver that will is Step 2b, and no engine is selectable
until Step 2c.

## Design

```
run's residency terms ──▶ clientForRun(selection)
                           │ LOCAL_ONLY?          → TOOL_RUNNER_LOCAL_ONLY_UNSERVED
                           │ no ANTHROPIC_API_KEY → EXTERNAL_CREDENTIAL_NOT_CONFIGURED
                           │ ANTHROPIC_CUSTOM_HEADERS set → SDK_AMBIENT_HEADERS_SET
                           ▼
                new Anthropic({ apiKey, baseURL (pinned), workspace header,
                                logLevel 'warn' + our logger, webhookKey null,
                                openTelemetry metadata_only / no propagation,
                                middleware: [messagesOnly] })
                           │
          every request ── messagesOnly ── requestRefusal(request)
                           │ not POST /v1/messages on the pinned origin → refused
                           │ thread / container / mcp_servers           → refused
                           │ a tool whose type is not custom            → refused
                           ▼
                         fetch
```

`local/anthropic-client-single-seam` refuses any load of an `@anthropic-ai/*`
package under `src/` except in `client.ts`. With the class importable in one
file, a second `new Anthropic(...)` cannot be written.

## Files

| File | Role |
| --- | --- |
| `package.json`, `package-lock.json` | `@anthropic-ai/sdk` `1.3.0`, exact; pi-ai keeps its nested `0.129.0` |
| `src/lib/agentic/tool-runner/client.ts` | `clientForRun`, `requestRefusal`, `toolRunnerModelFor` |
| `src/env.ts` | `AGENT_TOOL_RUNNER_MODEL_BALANCED` / `_DEEP`; `ANTHROPIC_CUSTOM_HEADERS`, read only to refuse |
| `eslint-rules/rules/anthropic-client-single-seam.js` | the one-construction-site rule |
| `eslint.config.mjs` | the rule on for `src/**`, off for the seam |
| `tests/guards/anthropic-client-single-seam.test.ts` | plants a construction and lints it with the real config |
| `tests/guards/eslint-local-rules-wired.test.ts` | the rule is wired at error |
| `docs/legacy-access-recertification-design.md` | the residency bullet names the client, which branches on residency ahead of its feature |
| `tests/guardrails/sub-processor-coverage.test.ts` | the three variables' triage |
| `tests/guards/dependency-risk-review.test.ts`, `docs/dependency-risk-review.md` | the review and its `REVIEWED` entry |

## Decisions

- **The rule polices the LOAD, not `new`.** A `new` expression can hide behind
  an alias, a re-export or a factory. A module that cannot import the class has
  nothing to construct. Type imports stay allowed, so an engine can use the
  SDK's message and tool types.
- **A rule file rather than a `no-restricted-syntax` selector.** The README
  prefers a selector, but two config blocks replace that list for their own
  files (the audit procedures) and one turns it off (the clipboard exemption).
  The guard test plants a construction in both directories to prove the rule
  still fires there.
- **Pin what the SDK reads from the environment.** The constructor reads
  `ANTHROPIC_BASE_URL`, `ANTHROPIC_LOG`, `ANTHROPIC_OPEN_TELEMETRY_*` and
  `ANTHROPIC_WEBHOOK_SIGNING_KEY` on its own. Each would move a run's traffic,
  log request content, or put prompts in spans, with no line of Inflect code
  saying so. Each is now an explicit option. `ANTHROPIC_CUSTOM_HEADERS` has no
  option that turns it off, so its presence refuses the client instead.
- **Refuse at the transport, not only in the runner's parameters.** The design
  already has the driver pass `thread: false`. The middleware makes forgetting
  it a refused request rather than a conversation stored at Anthropic. It also
  refuses the MCP connector and server tools, which run outside the funnel.
  Token counting is refused too until something needs it; widening the list is
  a reviewed diff.
- **The API version is asserted, not pinned.** 1.x hard-codes
  `anthropic-version: 2026-10-21`. Overriding the header would put the SDK's
  types out of step with the API it calls. A unit test asserts the version a
  request carries, so a bump that moves it fails there. The exact pin in
  `package.json` keeps a bump a reviewed PR.
- **The defaults for each tier live in one place.** The env vars have no zod
  default; `TOOL_RUNNER_DEFAULT_MODELS` holds them, so the default cannot
  disagree between `env.ts` and the code that reads it.
- **No dynamic-import boundary.** 1.3.0 ships a `require` condition and loads
  under Jest's CommonJS project, unlike `@flue/runtime`.
