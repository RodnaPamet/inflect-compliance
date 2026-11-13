# 2026-11-12 — Evaluations card on the organization settings page

**Commit:** `feat(org-settings): read-only Evaluations card for the garak and Inspect nightlies`

## Design

Owner decisions 2026-11-12: every organization's admins can read, by default, on
`/org/<slug>/settings`, what the platform's two LLM evaluation nightlies are and
where they are switched on and off.

```
page.tsx (server)
  getOrgCtx ──► evalsCardVisible({ orgSlug, orgRole, hiddenIn: env.EVALS_CARD_HIDDEN_ORG_SLUGS })
                   ├─ isOrgAdminTier(orgRole)          gate 1: owner or admin
                   └─ slug ∉ EVALS_CARD_HIDDEN_ORG_SLUGS  gate 2: not opted out
  showEvaluations && <OrgEvaluationsCard />            (server component, static)
                        └─ EVAL_NIGHTLIES (src/lib/evals/evaluation-nightlies.ts)
```

garak (`garak.yml`) red-teams the assistant through its own endpoint;
Inspect (`agent-evals.yml`) scores governed runs of the Flue and Tool Runner
engines. Both are GitHub Actions against a throwaway copy of the app on the CI
runner, never production, and both are switched by GitHub REPOSITORY variables
(`GARAK_ENABLED`, `AGENT_EVALS_ENABLED`) that the product cannot read. So the
card is static typed content: what each tests, its schedule (01:15 / 02:20 UTC
while on), its cap (USD 2.50 of the shared USD 5, D-EV-11; USD 10, D-EV-6),
its switch, its key secret with the `ANTHROPIC_API_KEY` fallback, and plain
external links to each workflow's runs page and the repository's Actions
variables page. It shows no on/off state and makes no request.

## Files

| File | Role |
| --- | --- |
| `src/lib/evals/evaluation-nightlies.ts` | The typed facts and the ONE repository URL every link derives from |
| `src/lib/evals/evals-card-visibility.ts` | The two-gate decision, pure; parses the comma-separated opt-out list |
| `src/app/org/[orgSlug]/(app)/settings/OrgEvaluationsCard.tsx` | The card: a server component, `Card` + `Heading` + `StatusBadge` + a `<dl>` per nightly |
| `src/app/org/[orgSlug]/(app)/settings/page.tsx` | Reads `EVALS_CARD_HIDDEN_ORG_SLUGS`, asks the gate, renders the card |
| `src/env.ts` | Declares `EVALS_CARD_HIDDEN_ORG_SLUGS` (server schema + `runtimeEnv`) |
| `tests/guardrails/sub-processor-coverage.test.ts` | Classifies the variable: an opt-out list of this deployment's own organizations, not a sub-processor |
| `messages/en.json`, `messages/bg.json` | `org.settings.evaluations.*` |
| `docs/deployment.md` | The variable's row in the environment table |

## Decisions

- **Static, and held to its sources by a test.** Copying a cron, a variable
  name and a budget into UI content is a drift waiting to happen, so the unit
  test reads each workflow's cron, the one `vars.*` it reads, every
  `secrets.X || secrets.Y` pair, the off-by-default condition and
  `workflow_dispatch`, plus `evals/cost-meter/shares.json` and
  `evals/inspect/budget.json`, and compares them with the typed content. A
  moved schedule fails CI, not the page.
- **Every organization by default; the variable is an opt-OUT list.** The
  owner decided the card shows in every organization, and that an
  organization that opts out is removed. An allowlist of every organization's
  slug would need an edit whenever one is created, so the default would
  quietly stop holding for the newest ones; an opt-out list keeps it true by
  construction. The variable is named for what it does
  (`EVALS_CARD_HIDDEN_ORG_SLUGS`), so nobody reads it as the allowlist it
  first was. It stays an operator variable rather than an org setting: the
  card describes this deployment's own CI.
- **Server-only reading of the variable.** The page (a server component) reads
  `@/env` and passes nothing but the rendered card down; the gate module
  imports no server code, so it stays unit-testable and client-safe, and no
  client module gains an `@/env` import.
- **`isOrgAdminTier`, never a literal role.** The owner sees it as an admin
  does; a reader of the page does not.
- **No client JavaScript.** The card has no `'use client'`; `StatusBadge`, its
  one client primitive, already ships on the page through the agent switches.
- **Strings carry names, not code.** Variable and secret names are ICU
  arguments rendered in `<code>`, so translation cannot alter them; the
  Bulgarian catalogue is complete.
