# 2026-10-31 — split the client environment out of `src/env.ts`

**Commit:** `(this PR)` fix(#4764): a client-reachable module imports no server env

## Design

`src/env.ts` declared ~90 server variables and one client variable in a single
`createEnv` call. A server variable's VALUE is unreadable in a browser — t3-env
throws — but its SCHEMA is ordinary module code: key names, `z.string()…`
calls, and the whole `runtimeEnv` mapping. `next build` bundles everything a
`'use client'` file statically reaches, so a single import edge put all ~90
declarations into a route's First Load JS.

There was exactly one such edge, and it was load-bearing: `notifications-bell.tsx`
is a `'use client'` component that the top chrome mounts on **every** workspace
page, and it imported `@/env` to read one feature flag.

```
before:  579 'use client' roots -> 929 client-reachable modules, src/env.ts AMONG THEM
         via: src/components/layout/notifications-bell.tsx -> src/env.ts
after:   579 'use client' roots -> 930 client-reachable modules, src/env.ts NOT among them
         client-reachable modules importing @/env directly: 1 -> 0
```

The split is therefore one new small module, one changed import, and a guard
that keeps the edge from coming back.

## How the cost was found

Not from this file's own reasoning — from a budget failure that looked like
something else. #4759 (the OpenShell gRPC transport) failed `Build` on:

```
/t/[tenantSlug]/(app)/controls/[controlId]/tests/[planId]/page: 669KB > 669KB budget
```

A controls test-plan page, in a PR about a transport. Joining main's last green
route table against that run's — the budget test prints all 183 routes on the
passing path, so this needed no rebuild — gave the shape:

```
changed=124  unchanged=59      nearly every delta exactly +0.1 KB
```

A shared module growing, not a route. (A leaked `@grpc/grpc-js` import, the
first suspicion, would have moved a few routes by hundreds of KB.) The PR's
only client-reachable change was four optional server strings in `src/env.ts`.

## Files

| File | Role |
| --- | --- |
| `src/env-client.ts` | NEW. `createEnv` with the `client:` block only, plus the `zod-jitless` side effect the browser parse needs. |
| `src/env.ts` | `client:` block and its `runtimeEnv` entry removed; the `zod-jitless` comment corrected, the import kept for the edge runtime. |
| `src/components/layout/notifications-bell.tsx` | `@/env` → `@/env-client`. The only source change. |
| `tests/helpers/client-import-graph.ts` | NEW. The graph walk, extracted so two guards share one definition of "client-reachable" and one definition of an edge. |
| `tests/guards/client-reachable-modules-import-no-server-env.test.ts` | NEW. The forcing function. No allowlist. |
| `tests/guards/client-reachable-modules-import-no-node-builtins.test.ts` | Rewired onto the shared helper; same verdict, 4/4 unchanged. |
| `tests/guardrails/sub-processor-coverage.test.ts` | Parses BOTH modules' `runtimeEnv` blocks. |
| `jest.config.js` | `^@/env-client$` mapped to `tests/mocks/env.ts` in all three projects. |

## Decisions

- **`src/env-client.ts`, not `src/env/client.ts`.** #4764 proposed the
  directory form. `src/env.ts` has to stay (94 server importers), and a
  `src/env.ts` file beside a `src/env/` directory resolves by precedence rather
  than by anything a reader can see. The flat form also matches `src/auth.ts`
  and `src/middleware.ts`.

- **The client block MOVED rather than being duplicated.** Leaving it in both
  modules would have needed no guard change and no mapper, but two declarations
  of one variable drift, and the drift is silent: the browser reads one copy and
  the server validates the other.

- **`sub-processor-coverage` had to widen in the same diff.** It derives its
  population by parsing `src/env.ts`'s `runtimeEnv` block. Left alone, it would
  have read the moved `NEXT_PUBLIC_NOTIFICATIONS_SSE` allowlist entry as stale
  and demanded its deletion, and every future client variable would have
  escaped sub-processor triage entirely — a compliance gate quietly narrowed by
  a bundle fix.

- **The walker was extracted, not copied.** Two walkers would eventually
  disagree, and the disagreement is silent in the dangerous direction: a walker
  that misses an edge reports "not reachable" about a module webpack bundles
  anyway.

- **The new guard has a positive companion.** "`src/env.ts` was not reached" is
  satisfied just as well by a walk that reached nothing — a renamed helper, a
  `clientRoots()` returning `[]`. So the suite also asserts the walk found >100
  roots, grew beyond them, and reaches `src/env-client.ts`.

- **Mutation-proved.** Restoring the bell's `@/env` import fails the guard and
  prints `src/components/layout/notifications-bell.tsx → src/env.ts`; 2 of 5
  tests fail. Restored, 5/5 pass. The failure names the edge, which is the
  whole point — the budget failure it replaces named a page instead.

- **`@t3-oss/env-nextjs` is ESM-only.** Both specifiers map to the one mock in
  all three Jest projects. Missing the mapper is not a subtle failure: the suite
  fails to load, with zero failed tests, which is what `notifications-bell-behaviour`
  did on the first attempt.

## What this does not do

It does not reduce any route below its budget — the `controls` bucket keeps the
669 → 670 raise #4759 took, because that raise paid for bytes that are now
gone and lowering a budget is its own measurement. It removes the ~90-variable
schema from the client graph, so the NEXT env variable costs no route anything.
