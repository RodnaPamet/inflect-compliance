# 2026-10-14 — retiring the typed-request intent layer (#3528)

**Commit:** `<sha> chore(ai): retire the typed-request intent layer`

Third and last of the day's AI withdrawals, after the TypeSafe sub-processor
withdrawal and the two-part Laya retirement. Owner decision, taken on a
measurement.

## Why

The layer had **never run in production.** `intentChooserForTenant` needs
`env.AI_LOCAL_BASE_URL`, and that variable has never been set on this
deployment — read off the running container with a positive control so an empty
result could not be mistaken for a failed probe:

```
$ docker inspect inflect-app-1 --format '{{range .Config.Env}}…'  | grep -cE '^[A-Z_]+='
53                                      ← the probe can see env vars
$ … | grep -oE '^(AI_LOCAL_BASE_URL|AI_[A-Z_]+)='
AI_POSTURE_PROVIDER=  AI_RISK_ENABLED=  AI_RISK_PROVIDER=
```

So every call refused `LOCAL_GATEWAY_NOT_CONFIGURED`, for every tenant, since
the feature shipped. The operator-facing sentence was already correct and
already told people to use the form; nobody was reading it because the form is
what they use.

Retiring rather than configuring: the only local model this deployment had was
Laya, retired earlier the same day after #3490 measured it answering from prompt
length rather than content. Standing up a replacement to serve a feature nobody
had used is not a trade anyone asked for.

## What went

```
src/app-layer/ai/intent/                    the whole directory
  laya-chooser.ts            the chooser (system-one wire)
  chooser-for-tenant.ts      the residency gate
  grant-intent.ts            the resolver, 348 lines
  relative-date.ts           its date-phrase parser
src/app/api/.../agent-proposals/compose/intent/route.ts
src/app/.../agents/compose/ComposeClient.tsx   the typed-phrase section
messages/{en,bg}.json                          10 keys each
public/openapi.json                            one path, 638 → 637
tests/unit/intent-{laya-chooser,chooser-for-tenant,compose-route,grant-resolver,relative-date}.test.ts
```

## Decisions

- **`AI_LOCAL_BASE_URL` STAYS, and this is the correction that matters.** My
  first scope listed it for deletion. Five other sites read it — Flue's
  `runtime-start.ts`, `runtime-bootstrap.ts`, `providers.ts` and
  `model-selection.ts`, plus `app-layer/ai/risk-assessment/index.ts`. Removing
  it would have taken out Flue's local-gateway path and the risk-assessment
  provider. The variable was never the intent layer's.

- **The UI affordance went with the layer**, and that was a scope correction too:
  the typed-phrase card, its handler, its state and ten i18n keys per locale. An
  input box that can only ever refuse is worse than either having the feature or
  not having it. The template **form** — what operators actually use — is
  untouched.

- **`relative-date.ts` went because nothing else used it.** Checked rather than
  assumed: its only importers were `grant-intent.ts` and its own test. The
  date-phrase grammar (`until friday`, `for 2 weeks`) has no other consumer.

- **`callSystemOne` and the wire codec STAY.** `transport.ts` is shared with
  `jev-provider.ts`, which remains in the source behind
  `TYPESAFE_SUBPROCESSOR_ACTIVE` by the owner's earlier decision to keep the Jev
  code inert.

- **`openapi.json` was hand-edited, not regenerated.** `npm run
  openapi:generate` is a jest test in disguise and migrates the shared test
  database, and a peer had jest and Prisma processes in flight. One path object
  was deleted through a serialiser proved byte-faithful on the unedited file
  first (indent 2, non-ASCII literal), so the diff is -35/+0 and nothing else
  reflowed. `route-contracts` and `api-schemas` pass against it.

- **A deleted test's lesson was kept as prose.** `identity-match-provider-factory`
  lost its intent-chooser budget test. What it proved outlives the constant: one
  timeout served two paths whose latencies differ by two orders of magnitude —
  adjudication p50 7.3 s against the chooser's 206 ms for three options — so
  raising the shared value for the slow path would have taken the user-facing
  compose route's ceiling from 6 s to 36 s. Split such a constant before raising
  it.

## The local typecheck could not be clean, and why that is not this change

`tsc --noEmit` reports five errors, all of the form *`parentExecutionId` does
not exist on `WorkflowRun…`*. None is from this change. `main`'s schema puts
that field on `WorkflowRun` (a peer's #3539, merged hours earlier) while the
generated Prisma client in `node_modules/.prisma` predates it — its 43
occurrences of the name all belong to `AutomationExecution`, a different and
pre-existing field. The client is a cross-branch global owned by whoever ran
`prisma generate` last.

Regenerating was refused rather than forgotten: two live node processes were
holding `PrismaClient` at the time, and worktrees share this `node_modules`, so
a regenerate would have swapped the client under a running peer. CI generates
fresh and is the typecheck authority for this branch.
