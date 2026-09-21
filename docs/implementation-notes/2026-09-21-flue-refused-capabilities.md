# 2026-09-21 — Sandboxes stay off, asserted where they can actually be stopped

**Commit:** `<sha>` feat(agentic): refuse the sandbox, channel and write-tool surface of the agent runtime

Point 10 of the Flue integration plan asks for *"Sandboxes stay off, asserted
in code and test"*. This is both halves.

## Design

The refusal list lives in `src/lib/agentic/flue/refused-capabilities.ts` — in
`src/`, as data, with a reason per entry. The guard imports it rather than
restating it, so the code half and the test half are one list and cannot drift.

**The enforcement is an import ban, and that is the whole control.**
`useSandbox` is a hook, not a setting: it is not switched on by configuration,
it is *called* by an agent function, and it cannot be called without being
imported. Refusing the import refuses the capability outright — no runtime path
around it, nothing to misconfigure at deploy time.

| | |
|---|---|
| `src/lib/agentic/flue/refused-capabilities.ts` | the refusals, as code, with reasons |
| `tests/guards/flue-refused-capabilities.test.ts` | the scan, the detector proofs, the allowlist |

## Decisions

### No runtime assertion, deliberately

The obvious companion is an `assertNoSandbox(config)` for the driver to call.
There is no driver construction seam yet, so it would be a function nothing
calls — which is the scaffolding this repo keeps finding, and which my own
Phase 1 audit criticised three PRs ago. It would read as defence while
defending nothing, and the day somebody forgot to call it, nothing would
notice.

When the driver gains a real agent-construction seam, a runtime check there is
worth adding — as a second layer, not as this one's replacement.

### The whole sandbox family, not just the obvious name

`useSandbox` alone is one import away from meaningless: the same capability
arrives through `sandboxFromDriver`, a `SandboxFactory`, or `createBashTool`.
Sixteen names, each with its reason.

`createWriteTool` / `createEditTool` are included although the plan does not
name them. They operate on the sandbox filesystem — inert without a sandbox,
dangerous with one — so listing them costs nothing today and closes the door a
future sandbox reinstatement would otherwise open by default. This is about the
*sandbox* filesystem, not database writes: those are refused by a stronger
mechanism, propose-not-commit.

### Refused is not the same as not-yet

`useSubagent`, `defineSubagent` and `GeneralSubagent` are **deliberately
absent**. Subagents are Phase 3 — *adopt*, once the subset invariant is proven.
Banning them here would make a later adoption look like a policy reversal
rather than the plan proceeding. A test asserts their absence from the list, so
the distinction survives someone tidying it.

Channels are in the list with a reason that says `SKIP` rather than a danger:
they duplicate `IntegrationConnection` plus notification dispatch. Skip and
refuse are identical in enforcement and different in intent, and "we already
have one" calls for a different conversation than "this is dangerous".

### An allowlist for packages, not a denylist

The registry carries eighteen `@flue/*` packages today and will carry more, so
enumerating the refused ones is a list that rots the moment somebody publishes a
nineteenth. `PERMITTED_FLUE_PACKAGES` is `['@flue/runtime']`; anything else in
`package.json` fails. `@flue/postgres` gets its own named assertion on top —
already covered by the allowlist, but worth being greppable from the package it
concerns, since it is the one the plan refuses by name.

## Three ways this guard could have been worthless

Each has a control, because a guard that cannot fail is the defect this repo
keeps finding.

**It scans nothing.** A population resolving to zero files passes every
assertion. So the scanned count is asserted (>500), and the two adapter files
are required to be in it by name.

**It cannot see a violation.** A regex that never matches passes just as
quietly. So the detector is exercised against every shape the real code could
take — a plain named import, one refused name hidden among permitted ones
(the realistic shape: nobody writes a line importing only `useSandbox`, it
arrives appended to an import that was already there), a multi-line clause, a
type-only import, an alias, and a dynamic `import()` / `require()`. It is also
asserted NOT to fire on the permitted surface or on a same-named import from
elsewhere — a detector that flags everything is as useless as one that flags
nothing.

**The list drifts into fiction.** A typo'd or renamed entry bans nothing and
reads as protection. So every refused name is checked against the installed
package's own export list, which means a major upgrade that renames an export
fails here rather than silently unbanning it.

## The guard that caught my guard

The first draft located the package's type declarations with
`path.join(REPO_ROOT, 'node_modules/@flue/runtime/dist/index.d.mts')`, and
`tests/guardrails/dependency-paths-are-resolved.test.ts` refused it — with the
reason this repo already knows: a spelled path into an installed package exists
only in a checkout that owns its install, so a `.claude/worktrees/<id>/`
checkout (which resolves upward to the primary clone and has no `node_modules`
of its own) fails, *or worse skips itself green behind an `existsSync` guard*,
while CI stays green.

The fix is more interesting than the rule. `require.resolve('@flue/runtime')`
does not work either: the package is ESM-only, its `exports` map declares
`types` and `import` conditions and no `require`, so CJS resolution of the
entry point, of every subpath, and of `package.json` all fail with
`ERR_PACKAGE_PATH_NOT_EXPORTED`. What does work is `require.resolve.paths()` —
Node's upward walk itself — followed by reading the package's own **declared**
`types` entry rather than a guessed internal layout.

And that turned up the second thing: the declared entry is `types/index.d.ts`,
a four-line shim that re-exports `../dist/index.d.mts`. The file I had spelled
was the right one, reached the wrong way and by luck; a future version that
moves it would have broken a hard-coded path silently. The helper now follows
the re-export, and throws rather than skipping when the package is absent.

## What was proved

Mutation-proved against real files, not synthetic ones:

| mutation | result |
|---|---|
| plant `import type { …, Sandbox } from '@flue/runtime'` into the live adapter | **1 red** |
| add `@flue/postgres` to `package.json` | **2 red** |

Both restored and re-verified by md5.

## What this does not cover

A refused capability reached through a package that is not `@flue/*` — a
sandbox library adopted on its own merits, say. That is a different decision
with a different review, and pretending this guard covers it would be the
overclaim it exists to avoid.
