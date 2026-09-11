# 2026-09-11 — AGENTIC UI 1/4: `/agents` as a standard list page

**Commit:** `<sha> feat(agents): make /agents a standard list page and move the agentic subtree under it (#2421-#2442)`

## Design

The agent register lived at `/t/:slug/admin/agents`, and the whole agentic
feature — register, proposal queue, orchestrator runs, receipt log, quarantine
triage, review-quality report — was reachable through exactly one affordance: a
pill labelled **MCP** on the admin landing page. An acronym naming a wire
protocol, two clicks deep, on a settings page.

```
BEFORE                                  AFTER
/admin  ──(pill "MCP")──> /admin/mcp    sidebar ──> /agents          (MAIN page)
                            ├─ card ──> /admin/agents                  ├─ /agents/[agentId]     (row click)
                            │             └─ /admin/agents/[agentId]   └─ Views ▾
                            │             └─ /admin/agents/review-quality   ├─ operate:   proposals, runs
                            ├─ card ──> /agent-proposals                    └─ assurance: receipts,
                            ├─ card ──> /agent-runs                                        quarantine,
                            ├─ card ──> /admin/mcp/agent-receipts                          review quality
                            └─ card ──> /admin/mcp/quarantine
                                                                    /admin/mcp → MCP credential panel only
```

Seven redirect shims keep every old path working. **The API did not move**:
every route stays at `/api/t/:slug/admin/agents/*` and
`/api/t/:slug/admin/mcp/quarantine`, because `ROUTE_PERMISSIONS` matches on the
API path, the route docstrings cite it, and `api-permission-coverage.test.ts`
curates `PRIVILEGED_ROOTS` from it. The UI path and the API path are allowed to
differ, and here they deliberately do.

### The three things that were more than a move

**1. The filters and the KPI counts moved to the server TOGETHER.** The register
SSR'd every agent and let the browser filter the array. That is survivable while
the table is the only consumer and stops being survivable the moment a card
quotes a number: the card's filter resolves against the whole tenant while the
array is capped, so a card reads 3 and the click produces 47 (#1905). So
`RegisteredAgentRepository` grew ONE predicate builder (`_buildWhere`) that the
list and all four counts share with one term swapped, and the page reads
`searchParams`.

**2. Three pages had no gate of their own.** Receipts, quarantine and
review-quality docstrings said "Admin-gated by the parent /admin layout" — and
that sentence WAS the gate. Moving the files out of `/admin` would have silently
removed the only check on each. `admin.agent_registry`, checked before the data
load. Proposals and runs keep `admin.view`, unchanged: their APIs are gated only
by `assertCanRead`, so the page check is the whole narrowing and re-keying it
would be a permissions change rather than a routing one.

**3. The register's READ was gated on nothing but `assertCanRead`.** Which every
role holds. `admin.agent_registry` governed the Add button while the record of
what is running was readable by anybody who could read anything — invisible
while the layout above refused the same people, load-bearing the moment the page
left `/admin`.

## Files

| File | Role |
| --- | --- |
| `src/app/t/[tenantSlug]/(app)/agents/**` | The moved subtree: register, detail, proposals, runs, receipts, quarantine, review quality |
| `…/agents/page.tsx` | Server component: parses filters, loads rows + KPI counts + governance + proposal badge, gates |
| `…/agents/AgentsClient.tsx` | The list page: KPI strip, three-state banner, `selectionEnabled: false`, single-click row open |
| `…/agents/AgentsViewsMenu.tsx` | The five-entry / two-group menu. Its own file because two SERVER pages mount it |
| `…/admin/agents/**`, `…/admin/mcp/{quarantine,agent-receipts}`, `…/agent-{proposals,runs}` | Seven `redirect()` shims |
| `…/admin/mcp/page.tsx` | Restated: card grid retired, credential panel kept, one link onward |
| `…/dashboard/AgenticGovernanceCard.tsx` | A kill switch in force, visible from the dashboard for the first time |
| `src/app-layer/repositories/RegisteredAgentRepository.ts` | `_buildWhere`, `kpiCounts`, `AgentListFilters` with `UNSCORED` as a member |
| `src/app-layer/usecases/agent-registry.ts` | The read gate, `parseAgentListFilters`, `listAgentKpiCounts`, `getAgentGovernanceStatus`, `getAgenticDashboardSummary` |
| `src/app-layer/notifications/agentic.ts` | The two agentic bells + recipient resolution |
| `src/components/layout/{SidebarNav,nav-item}.tsx` | The Manage-section entry; `NavGlyph` widened for Nucleo |
| `src/components/ui/views-menu.tsx` | `badge` / `badgeLabel` on `ViewsMenuItem` |
| `src/components/command-palette/use-palette-commands.ts` | Three agentic entries, labelled by destination |
| `prisma/schema/enums.prisma` + `prisma/migrations/20260911140000_agentic_notification_types/` | Two `NotificationType` members |

## Decisions

- **`nav.agents = "Agent"`, not `nav.agent`.** All seven sibling entity keys are
  plural-key / singular-value (`nav.assets` = "Asset"). The roadmap prompt asked
  for the singular key; taking it would have made this the only one breaking the
  shape.

- **Nucleo `Robot`, not lucide `Bot`.** `SidebarNav` is on
  `LEGACY_LUCIDE_USERS` as a migration TODO, so "the file already imports
  lucide" argues for the wrong family. Robot was already the glyph on both
  existing agent surfaces. This cost a type widening: `NavItemProps.icon` was
  `LucideIcon`, and a Nucleo component is a plain function, so the prop type had
  to stop forbidding the family everything is migrating TO. Same widening on
  `PaletteCommand.icon`.

- **The four KPI cards are total / active / unscored / egress.** Each maps to a
  SINGLE-value filter, because `set(key, value)` replaces with `[value]` and a
  card whose click needed two values could not promise its own number.
  `unscored` is `riskTier IS NULL`, which made `UNSCORED` a first-class filter
  member rather than an absence — and it composes with real tiers via an `OR`,
  so selecting UNSCORED and HIGH yields both.

- **`/admin/mcp` was RESTATED, not retired.** Its five cards all pointed at
  moved pages, so repointing them would have left a second, worse navigation for
  surfaces that now have a real one. The grid is gone; the credential panel —
  the one thing the page uniquely carried — stays, with one link onward. It is
  not redirected because prompt 2/4 merges that panel into `/admin/api-keys`,
  and a redirect to a page that does not carry the content is worse than a page
  that does.

- **The seven shims went into `design-system-drift`'s MIGRATED_PAGES, not its
  unmigrated tally.** Each is a `redirect()` one-liner with no JSX and no
  className, so it satisfies all three anti-drift checks by construction rather
  than by judgement. Counting them would have meant raising a ceiling by seven
  for files that cannot drift.

- **The agentic bells are ENGAGED and QUARANTINED, with no counterparts.** A
  kill switch being LIFTED is the ordinary end of an incident the recipient is
  already inside. A proposal being CREATED is the case the propose-not-commit
  queue exists to accumulate, and one bell per proposal would train the
  recipient to ignore the bell, taking the other two with it — the waiting count
  is surfaced on the register's menu and the dashboard card instead.

- **`MEASURED_SINKS` in `no-raw-prompt-logging` went 76 → 78 and
  `MEASURED_HOLES` did not move.** Both new `logger.warn` catch-sites were
  written with `err.message` and a literal rather than `String(err)`, which is a
  `TRANSPARENT_CALL` the rule walks into and then records a hole for. Raising the
  denominator alone TIGHTENS `HOLES_PER_SINK_CEILING`.

- **Three corrections to the brief are recorded in the PR body**, the largest
  being that `route-permissions.ts` covers the API surface only
  (`^\/api\/t\/[^/]+`), so the UI move needs no rule there at all.
