# 2026-11-15 — F3 recorded: Flue telemetry stays on the existing pipeline, `@flue/opentelemetry` is not taken

**Commit:** see the `record-flue-f3-decision-5335` branch (`docs(ai-roadmap): record F3 …`).

## Design

F3 is a residual of the 2026-10-09 audit of Flue Phase 1: the plan's
"wire up the telemetry" was not done by adopting `@flue/opentelemetry`.
It was re-verified on 2026-11-11 against 3.364.1 and again for this note
against 3.387.2, and it is unchanged. The master roadmap has called it
"a decision to record, not a gap" since; this note is that record (#5335).

**The state.** Flue emits spans through `getTracer` from
`@/lib/observability/tracing` — the same tracer every usecase and job
already writes to — from `src/lib/agentic/flue/telemetry.ts`, which
value-imports `instrument` from `@flue/runtime` and installs no SDK,
registers no processor and owns no transport. Its `observe` subscriber is
deliberately empty; the INTERCEPTOR is what emits, and it sees an
operation's shape — an agent turn, a model call, a tool by name.

**Two reasons, and they are enforced by two different guards.** That
separation is the part worth writing down, because the obvious summary —
"the allowlist keeps Flue telemetry clean" — is wrong about half of it.

1. **No second exporter.** `@flue/opentelemetry` would bring its own SDK,
   processor and transport, so a Flue run's spans would carry their own
   sampling, retention and credentials and land in a parallel trace
   instead of the one belonging to the HTTP request or job that started
   the run. This is what `PERMITTED_FLUE_PACKAGES` refuses: one member,
   `['@flue/runtime']`, in `src/lib/agentic/flue/refused-capabilities.ts`,
   held to exact set equality against what `package.json` declares by
   `tests/guards/flue-refused-capabilities.test.ts`. So an
   `npm install @flue/opentelemetry` fails CI until somebody widens the
   allowlist in the same diff. It is an allowlist rather than a denylist
   because the registry carries eighteen `@flue/*` packages and will
   carry more, so a denylist would rot the day a nineteenth is published.

2. **No model or tenant content on spans — and the allowlist is NOT what
   holds this.** Subpaths of a permitted package are permitted, by
   decision: `@flue/runtime/node` and `@flue/runtime/telemetry` are how
   the runtime is actually imported, and an exact-match check refused
   them. But `@flue/runtime/telemetry` ships the helpers whose whole
   purpose is to put content on spans — `inputMessages`,
   `outputMessages`, `agentInputMessage`, `agentOutputMessage`,
   `contentAttribute`, `systemInstructions` — and
   `FlueObservationDetail` carries `agentInput`, `agentOutput.text`,
   `args` and `effectiveResult`: the prompt, the answer, and every
   tool's arguments and results. Reaching for those helpers is the
   obvious reading of "wire up the telemetry" and the allowlist would
   not stop it. What stops it is a separate, structural guard,
   `tests/guards/flue-telemetry-carries-no-content.test.ts`, which names
   the six helpers and fails on a reach for any of them. It is
   structural rather than behavioural on purpose: the wrong version
   passes every functional test, because the spans are still correct
   spans. Spans leave this system for a backend with its own retention
   and access control and none of this platform's tenant isolation or
   encrypted-field manifest, so forwarding content there would defeat
   `no-raw-prompt-logging` through a channel nobody greps.

**What taking the package would require.** Widening
`PERMITTED_FLUE_PACKAGES` in a reviewed diff, and then satisfying the
content guard anyway — so the bridge would have to be configured to
forward operation shape only, which is exactly what the interceptor
already does. The package buys nothing here, which is why this is a
decision rather than deferred work.

## Files

| File | Role |
| --- | --- |
| `docs/implementation-notes/2026-11-15-flue-f3-telemetry-stays-hand-rolled.md` | this record |
| `docs/ai-architecture-roadmap.md` | Wave 0's F3 event reads done; the status board's Flue row has no open decision; the "Existing roadmaps" row and the Layer 2 residuals bullet point here |

## Decisions

- **This note records the current state and its reasons; it is not an
  owner ruling.** #5335 says its blocker is "owner initial, if the
  decision is to be the owner's rather than a record of current state".
  The state is guard-enforced and was not adopted by anybody's fiat, so
  it is recorded as what holds today — "not taken, for these reasons" —
  rather than as "never permitted". Elevating it to a standing ruling is
  one line and an initial on #5335.
- **The roadmap's own F3 sentence is corrected here**, not just marked
  done. It read that the allowlist "blocks `@flue/opentelemetry`, so
  telemetry stays hand-rolled (`flue/telemetry.ts`, content-free by
  guard)", which reads as though one mechanism does both jobs. The
  allowlist governs the exporter; a different guard governs the content,
  and it has to, because the permitted package's own subpath ships the
  content helpers. The document's banner asks for exactly this: if the
  code contradicts a fact here, the code wins and the pull request that
  finds it corrects the document.
- **No code changed.** F3 was a record to write, and writing it found a
  documentation error rather than a defect.
