# 2026-11-24 — Mobile: KPI strip, Internal Audit hub, vendor questionnaire, shared-audit picker, agent tabs

**Commit:** see the pull request closing #5894, #5895, #5896, #5897 and #5898 (epic #5868).

## Design

Five phone layouts from the epic's owner decisions of 2026-11-23. One new
shared primitive, four page-level changes.

**`<KpiStrip>` (`src/components/ui/kpi-strip.tsx`, #5895).** A page's KPI tiles
render once, in one list that is a sideways-scrolling `flex` row below `md`
and `md:grid` (with the caller's columns) from `md` up. Below `md` every
direct child is `w-40`, `shrink-0` and `p-3`, and a `KPIStat` value
(`[data-metric-value]`) drops to `text-xl`, so a `KpiFilterCard`, a dashboard
metric card or the SoA's own tile all come out compact without knowing they
are in a strip. The cue is CSS too: the end edge fades (a mask) over the tile
it cuts, and a trailing `::after` spacer as wide as the fade lets the last
tile scroll clear of it. The module carries no JavaScript beyond its label.

Adopted by every list page with a KPI row (controls, evidence, vendors,
risks, tasks, assets, policies, agents, tests, incidents), the vendors
dashboard (both rows) and the SoA, whose `useIsBelowMd` branch between a
strip and a grid it replaces.

**Internal Audit hub (#5894).** The client renders one `flex flex-col
gap-section` column (the page's `space-y-section` rhythm); below `md` the
lifecycle guide alone takes `order-last`, so the list comes first. The guide
collapses behind a phone-only disclosure (its subtitle, links and steps are
`max-md:hidden` until opened); the empty "select an audit" panel is not drawn
on a phone; choosing an audit scrolls its detail into view there.

**Vendor questionnaire (#5896).** A required question left empty is caught
before the round trip; each question shows its own error (and the server's
field errors land the same way), the summary at the top counts them, and the
page scrolls to the first one and focuses its first control. Choices are 44 px
rows that take the tap (the 20 px native input ignores pointer events, so a
tap anywhere on the row checks it); a progress count sits in the submit bar,
which is sticky above the bottom inset on a phone.

**Shared audit pack (#5897).** "About" is the shared `Combobox` (searchable,
virtualised above 50 options) with the whole pack pinned first, in place of
one chip per item. The four comment kinds are a two-by-two grid of 44 px rows
below `md`, the wrapping row from `md` up.

**Agent detail page (#5898).** Nine sections, four tabs:

| Tab | Sections |
| --- | --- |
| Overview | Overview |
| Assessment | Risk assessment, ASI coverage |
| Authority | Policy card, Tools, Skills, Behaviour |
| Activity | Runs, Circuit breaker |

The group strip is the page's tab bar (`EntityDetailLayout`'s cued strip); a
group with more than one section shows a second `ScrollCueStrip` of section
tabs (`AgentSectionStrip`) and a panel labelled by the open section. The
page now reads and writes `?tab=`: a section key opens it, a group key opens
its first section the reader may open, anything else opens Overview.

## Files

| File | Role |
| --- | --- |
| `src/components/ui/kpi-strip.tsx` | The KPI strip primitive. |
| `src/app/t/[tenantSlug]/(app)/*/…Client.tsx`, `tests/page.tsx`, `vendors/dashboard/page.tsx`, `reports/soa/SoAClient.tsx` | KPI rows adopt `KpiStrip`. |
| `src/app/t/[tenantSlug]/(app)/audits/AuditsClient.tsx` | List first, guide disclosure, no empty panel, scroll to detail. |
| `src/app/vendor-assessment/[assessmentId]/VendorAssessmentClient.tsx` | Inline errors, reveal, choice rows, progress, sticky bar. |
| `src/app/audit/shared/[token]/page.tsx` | Combobox picker, kinds grid. |
| `src/app/t/[tenantSlug]/(app)/agents/[agentId]/agent-detail-tabs.ts` | Groups, `resolveAgentDetailTab`, skeleton count. |
| `src/app/t/[tenantSlug]/(app)/agents/[agentId]/AgentSectionStrip.tsx` | A group's section strip and panel. |
| `src/app/t/[tenantSlug]/(app)/agents/[agentId]/AgentDetailClient.tsx`, `page.tsx` | Grouped tabs, `?tab=` in and out. |

## Decisions

- **CSS switch, not a JS one, for the KPI strip.** The tiles render once, so
  an `id` a tile carries stays unique and nothing waits for `matchMedia` on
  hydration; the SoA's `useIsBelowMd` branch is gone with it.
- **The KPI strip's cue is a CSS fade, not `ScrollCueStrip`.** The issue
  suggested the scroll strip; built on it, the strip put `ScrollCueStrip` and
  the strip (about 1.9 KB gzipped) into the split chunk every list page and
  the controls and risks detail routes load, which took the `controls` bucket
  2.6 KB and `risks` 0.7 KB over budget (`controls/.../tests/[planId]` 689.6 ->
  692.6 KB locally). Four 160 px tiles never fit a phone, so a static end fade
  is a true cue whenever the strip overflows; what it gives up is the
  start-edge fade, the chevron and keeping the selected tile in view (an
  effect for that alone was the last 85 bytes over the `controls` budget).
- **The dashboard's own KPI grid is left as it is.** On the dashboard the
  tiles are the content, not chrome ahead of a list, and the issue names the
  list pages, the vendors dashboard and the SoA.
- **The agent page is grouped at every width.** One tab bar shape for every
  reader; rendering nine tabs on a desktop and four on a phone would mean two
  sets of tab ids or a hydration-time switch. Each section keeps its old tab
  id (`tab-runs`) and panel id (`tabpanel-runs`) inside its group.
- **`?tab=` names the section, not the group**, so the address keeps the
  vocabulary the nine-tab page had and every former section is linkable. It is
  written with `history.replaceState`: the server has nothing new to render.
- **The questionnaire's required check runs in the client** as well as the
  server, so a missing answer is named without a round trip; the server's
  field errors still arrive per question and are revealed the same way.
- **The questionnaire keeps native inputs, not the Radix `RadioGroup`.** The
  public page loads none of the app's primitives; importing `RadioGroup` and
  `Checkbox` there regrouped the app's shared split chunks and cost the
  controls routes 1.6 KB (measured: `controls/.../tests/[planId]` 691.6 KB with
  them, 690.0 without), past their budget. The 44 px row is what the issue
  asked of them.
- **The comment picker is a combobox at every width**: one chip per item was
  a wall on a desktop too. The kinds stay a wrapping row from `md` up.
