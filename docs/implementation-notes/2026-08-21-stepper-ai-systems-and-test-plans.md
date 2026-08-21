# 2026-08-21 — prev/next stepper on AI systems and test plans

**Commit:** `feat(ui): step through AI systems and test plans from their detail pages`

## Design

Three detail routes were named as the last ones with a real sibling list and
no stepper. One of the three turned out not to be a detail route at all.

### `issues/[issueId]` — declined, the premise no longer holds

Both `issues/page.tsx` and `issues/[issueId]/page.tsx` are server-side
`redirect()`s to `/tasks` and `/tasks/{id}` (`3289620aa`, #1139). They ship
zero client JS and render nothing. `/tasks` already publishes its displayed
order (`TasksClient.tsx`) and `/tasks/[taskId]` already reads it, so a user
who follows a legacy `/issues/{id}` link lands on a page that HAS the stepper.
There is nothing to wire and nothing to adopt.

### The shared structural reason, and why `EntityDetailLayout` is not the answer

The remaining two pages were missed by the earlier sweep because that sweep
keyed on `EntityDetailLayout` — the shell that owns the `prevNext` prop. But
the stepper does not need the shell. `EntityDetailLayout` renders it by
forwarding one node into `PageHeader`'s `titleAdornment` slot, and any page
can pass that slot itself. So the question per page was "can this page reach
the adornment seam?", not "should this page be migrated?".

- **`risks/ai-systems/[systemId]`** already renders `<PageHeader>` directly,
  so it gained the stepper by passing one more prop. Migrating it to
  `EntityDetailLayout` would have bought nothing: it has no tabs, no
  loading/error/empty lifecycle (the data arrives from a server component as
  props), and a bespoke `Row`-based metadata card that would have stayed
  exactly where it is.
- **`tests/plans/[planId]` / `controls/[controlId]/tests/[planId]`** share
  `TestPlanDetailView`, which hand-rolls its header (`Breadcrumbs` +
  `BackAffordance` + `Heading` + badge strip + action cluster). Adopting the
  shell there is a 520-line component's worth of churn for one prop, and the
  page's action row is not the shell's `actions` shape. It got the nav as an
  explicit sibling of its `<h1>` instead — the same DOM relationship
  `titleAdornment` produces, for the same accname reason.

Both are declines of the *shell*, not of the *stepper*.

### Publish/read wiring

```
/risks/ai-systems  (server-rendered rows → AiSystemsClient)
     │ publish CACHE_KEYS.aiSystems.list()  ← filtered rows
     ▼
AiSystemDetailClient   useEntityListIds(null, { orderKey: aiSystems.list() })

/tests  (register: filter + client sort)
     │ publish CACHE_KEYS.tests.plans()  ← sortedPlans
     ▼                                          context="tests"
TestPlanDetailView ──┤
     ▲                                          context="control"
     │ publish CACHE_KEYS.controls.testPlans(controlId)  ← plans
TestPlansPanel  (control detail page)
```

## Files

| File | Role |
|---|---|
| `src/lib/swr-keys.ts` | New `aiSystems` resource + `controls.testPlans(id)` — one string shared by publisher and reader by construction |
| `…/risks/ai-systems/AiSystemsClient.tsx` | Publishes the tier-filtered rows it paints |
| `…/risks/ai-systems/[systemId]/AiSystemDetailClient.tsx` | Reads the order, renders the nav through `PageHeader.titleAdornment` |
| `…/tests/page.tsx` | Publishes `sortedPlans` (not the load-more window) |
| `src/components/TestPlansPanel.tsx` | Publishes one control's plans under the control-scoped key |
| `src/components/test-plans/TestPlanDetailView.tsx` | Picks the order key + href builder per `context`, renders the nav beside the `<h1>` |

## Decisions

- **AI systems read with a null `listKey`.** The registry is server-rendered,
  so its rows never populate an SWR cache entry — a fallback read would fire a
  fresh `GET /ai-systems` on *every* detail load to serve arrows for a list the
  deep-linking user never saw. Hiding the arrows is the contract's documented
  semantic for that case. Test plans do the opposite in the `tests` context,
  because the register's own SWR key *is* `tests.plans()` and the fallback
  costs nothing extra.
- **The plan stepper is context-scoped, not one list.** A control's plans are a
  strict subset of the register's, and the two routes carry different URLs.
  Reading the register's order from `/controls/{controlId}/tests/{planId}`
  would step to a plan owned by a different control while the URL still named
  this one. `controlScoped` chooses both the order key and the `hrefFor`
  shape.
- **The nav is a sibling of the `<h1>`, never inside it.** Per accname, a
  descendant control's `aria-label` is concatenated into the heading's own
  accessible name, so a nested nav makes Chromium announce the page title as
  "<plan name> Previous item Next item". jsdom cannot see this
  (`dom-accessibility-api` deliberately skips that step), so it is a comment
  and a composition rule rather than a test.
- **`labelSingular` falls back to the generic phrase for now.** Neither
  `aiSystem` nor `testPlan` is in `STEPPER_ENTITIES`, and the catalog
  (`messages/en.json` / `messages/bg.json` / the set itself) was frozen behind
  an in-flight PR when this landed. Both render "Previous item" / "Next item"
  until the slugs are added centrally — the tests assert exactly that, so
  adding the phrases is a visible, deliberate change rather than a silent one.
