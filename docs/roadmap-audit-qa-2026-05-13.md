# Roadmap QA Walkthrough — 2026-05-13

> **Status: historical record (2026-05-13)** — describes the state of the system at the time of writing; kept for the record, not maintained. For current behaviour see the relevant subsystem doc in docs/.

QA checklist for the deployed app. **What I already verified
structurally lives in the next section** — the table below covers only
the things that need a real browser to confirm.

---

## What I verified from code (you don't need to check)

I walked the first audit doc and ran 501 structural ratchets (all
green). These items are confirmed at the source / class-string level:

- ✅ **Active band tone (#463 v2)** — `before:bg-[…]!` override
  carries three `var(--bg-page)` linear-gradient stops + the stardust
  radial layers. The v1 silent-failure case is gone.
- ✅ **Per-page searchbar removal (#440, #443)** — 7 list-page Clients
  (controls, risks, policies, tasks, evidence, assets, vendors) contain
  zero `searchPlaceholder` / `searchId`. Combobox-in-modal placeholders
  are unaffected (different mechanism).
- ✅ **NotificationsBell (#432 + #456)** — hover uses `bg-bg-muted/50`
  (canonical), date routed through `formatDateCompact`.
- ✅ **TenantSwitcher + UserMenu (#428 + #439)** — both read session
  data via props (no `useSession()` hook anywhere); `AppShell` →
  `TopChrome` → switcher/menu threading is in place.
- ✅ **EmptyState personality (R11-PR1)** — all 8 list-page Clients
  import `EmptyState`.
- ✅ **EntityDetailLayout** — 11 detail pages adopt the shell.
- ✅ **MetaStrip/MetadataBar** — 10 detail pages render it.
- ✅ **HeroMetric (#202)** — 72px tabular-nums.
- ✅ **NextBestActionCard (#203)** — mounted on dashboard.
- ✅ **EnvironmentBadge (#433)** — client hostname detection (no env var).
- ✅ **Brand mark pulse (#427)** — `animate-nav-brand-pulse` wired.
- ✅ **Mobile unified chrome (#436)** — no dual top bar.
- ✅ **R12-R15 NavItem** — all keyframes + composed animations
  (`nav-band-alive`, `nav-band-active-alive`, `nav-row-liquid-sweep`)
  declared and wired. Per-row drift CSS-var delays present. Magnetic
  letter tracking on the label span. Page-bg active band tone v2 in
  place. Iridescent border (#449) cleanly removed (#454).
- ✅ **501/501 sidebar+topbar ratchets** pass locally.

## What I found broken from code review

🚩 **v2-PR-12 (#204) — DataTable row "chevron-right on hover" claim is
NOT implemented.** Only the brand-coloured left edge (R13-PR13) ships.
A stale comment at `table.tsx:400` describes a chevron-cell that
doesn't exist; no `ChevronRight` is imported or rendered in the table
primitive. The v2-PR-12 PR description said "chevron-right + brand
left edge on hover" — only half delivered.

If you want this fixed, I can ship it as a focused PR: render
`<ChevronRight aria-hidden className="opacity-0 group-hover/row:opacity-60 transition-opacity">`
in the last data cell of every row that has `onRowClick`. Otherwise
update the PR description / audit doc to reflect what actually
shipped.

---

# QA checklist (browser-required)

## How to use

- Each row tells you: **go where**, **do what**, **see what**.
- Status defaults `?`. Fill in `OK` / `🚩 BROKEN` / `🟡 PARTIAL` / `SKIP`.
- 🚩 anything weird; we'll triage by tag.
- Mobile rows assume a 375px viewport (iPhone SE). Resize DevTools or use
  the device toolbar.
- Two themes: METRO (dark, navy) is default; the light theme (cream) toggles
  via the user-menu (top-right avatar → theme row).
- "Active sidebar row" means: navigate to the page so it's the current
  highlighted item; the row should look distinctly engaged.

---

## A. Sidebar — Lickable + Living + Stardust (R12 + R13 + R15)

The sidebar is the chrome you brush past hundreds of times a day. Every
row in this section should be checked on **both themes**.

| # | Where + what to do | What you should see / feel | Status |
|---|---------------------|----------------------------|--------|
| A1 | Idle sidebar — don't hover or click anything. | Section headers (Govern / Comply / Manage) read as small uppercase chips. Try selecting one with your cursor — should be **impossible to select**. | ? |
| A2 | Hover a sidebar row (e.g. Controls). | A thin (3px wide) **brand-coloured band** appears on the LEFT edge of the row. Brand = yellow on dark / orange on light. No full-row tint. The row's label text brightens slightly. | ? |
| A3 | Keep hovering. | The band should slowly **pulse along its length** (4-second cycle). Watch closely — it's gentle. | ? |
| A4 | Keep hovering. | You should see **3 faint white particles** fading top-to-bottom on the band (stardust trail — bright top, dim bottom). | ? |
| A5 | Keep hovering. | The whole band should slowly **breathe brighter and dim** over 6 seconds. Different cycle from the shimmer — they never re-sync. | ? |
| A6 | Move pointer ONTO a row from outside. | The band should "draw itself" **top-to-bottom over ~450ms** when it appears (not all-at-once). | ? |
| A7 | Keep hovering. | A subtle **horizontal light sweep** crosses the row body once (diagonal, brand-tinted, ~1.2s) when hover engages, then disappears. | ? |
| A8 | Keep hovering. | The **label letters should open slightly** (more spacing between them) over ~200ms. Look closely — they spread. | ? |
| A9 | Keep hovering. | A faint **hairline of light** appears across the TOP edge of the row. | ? |
| A10 | Keep hovering. | A subtle **shadow at the BOTTOM edge** of the row, giving a slight pressed/concave feel. | ? |
| A11 | Hover several rows in turn. | Each row's band shimmer/breath should be at a **different phase** — they should NOT pulse in lockstep. (Asymmetric per-row drift.) | ? |
| A12 | Press-and-hold a sidebar row (mousedown). | Row drops 1px **AND** compresses ~1% (visibly slightly smaller). Release → springs back. Should feel like pressing a real button. | ? |
| A13 | Click any row to navigate. | The moment the new row becomes active, its band glow should **bloom outward briefly** (~700ms) then settle. Like a starburst. | ? |
| A14 | Look at the active row (current page). | **Active band tone**: NAVY on dark / WARM GREY on light. NOT yellow / orange. Should look like a cut-out showing the page underneath. | ? |
| A15 | Look at the active row's label. | **Brand-colored letters**: yellow on dark / orange on light. (Not the muted default tone.) | ? |
| A16 | Look at the active row's overall background. | A **radial wash** of brand-secondary (navy/deep-navy) that's strong near the left edge and fades to nothing on the right. NOT a uniform fill. | ? |
| A17 | Look at the active row. | A **soft outer halo** (brand-secondary at low alpha) bleeds around the row's perimeter. The active row's tonal presence extends beyond its footprint. | ? |
| A18 | Tab through the sidebar (no mouse). | Each row gets a **2px brand ring** on focus (yellow/orange with a small offset). The ring should look deliberate, not the browser default. | ? |
| A19 | Switch theme (avatar → theme toggle). | All of the above should still work — colors swap (yellow→orange, navy→deep-navy) but the BEHAVIOURS stay identical. | ? |
| A20 | Look at the gap between sections. | A **soft fading hairline** divider, not a hard line. | ? |
| A21 | Sidebar — go to Calendar (if you have an upcoming-event count). | Count badge should **fade in smoothly** (~300ms) on first load, not snap in. | ? |
| A22 | Active sidebar row. | The active band should **also slowly pulse + breathe + halo** continuously (not just one-shot like hover). | ? |
| A23 | Iridescent border on hover. | **Should NOT exist** — no perpetual outline cycle. Verify the row's outline is empty. | ? |

---

## B. Top-bar — Living Top-Bar (R14)

| # | Where + what to do | What you should see / feel | Status |
|---|---------------------|----------------------------|--------|
| B1 | Look at the top-bar height. | ~64px tall (about 1 row taller than what you might remember pre-R14). | ? |
| B2 | Look at the top-left brand mark. | Pulses slowly — a gradient pans across the mark every ~6 seconds. | ? |
| B3 | Click the tenant pill (top-left, after brand mark). | A **popover** opens listing your tenants. Click any to switch. If you only have one tenant: popover should still open and show that single membership. | ? |
| B4 | Click your avatar (top-right). | Dropdown shows: name + email header → theme toggle row → sign-out at bottom. | ? |
| B5 | Look at the top-bar centre. | **Empty.** No ⌘K pill or search anchor. (Retired in #440.) | ? |
| B6 | Top-bar — bell icon (right of centre). | If you have unread notifications, a **red badge with a count** sits on top of the bell. Click the bell → popover with notifications + "mark all read". | ? |
| B7 | Click an unread notification. | Marks it read (badge count drops). Navigates to the linked page if linkUrl is set. | ? |
| B8 | Open the bell popover with NO unread notifications. | Personality EmptyState: "All clear" or similar (NOT a generic "No notifications"). | ? |
| B9 | Look at the top-bar BG. | A subtle **brand-coloured radial wash on the right side** fading to transparent. (R14-PR10 living chrome.) | ? |
| B10 | Click any top-bar control (brand mark, tenant, bell, avatar). | All drop 1px on press, spring back on release (shared NAV_BAR_SLOT_PRESS). | ? |
| B11 | Visit `https://staging.<your-domain>` (or whatever your staging URL is). | An amber **STAGING** badge appears in the top-bar left slot. | ? |
| B12 | Visit a dev URL (`*.dev.*`, `localhost`, etc.). | A red **DEV** badge in the top-bar left slot. | ? |
| B13 | Visit prod URL. | No environment badge anywhere. | ? |

---

## C. Mobile (375px viewport) — R14-PR12

DevTools → device toolbar → iPhone SE. Or resize browser to 375px wide.

| # | Where + what to do | What you should see / feel | Status |
|---|---------------------|----------------------------|--------|
| C1 | Mobile — top-bar. | Single bar, NOT two stacked. Has: hamburger (left) + brand mark + (env badge if staging/dev) + bell + avatar. | ? |
| C2 | Mobile — tap hamburger. | Side drawer slides in with full sidebar nav. | ? |
| C3 | Mobile — tenant pill. | Hidden below 640px (no room). To switch tenants, use avatar menu → footer link to `/tenants`. | ? |
| C4 | Mobile — breadcrumbs. | Hidden below md (768px). | ? |
| C5 | Mobile — any list page. | Filter chips collapse to a `Filters (N)` popover. Primary CTA stays visible. | ? |

---

## D. List pages — DataTable + FilterToolbar + EmptyState

Run through this on `/t/<slug>/controls`, then spot-check on
`/risks`, `/policies`, `/tasks`, `/assets`, `/vendors`, `/evidence`,
`/findings`, `/frameworks`. If they behave differently between pages,
flag the page name in the status.

| # | Where + what to do | What you should see / feel | Status |
|---|---------------------|----------------------------|--------|
| D1 | Load `/t/<slug>/controls`. Look at the page header. | Eyebrow chip + title + 1-sentence description. Action button on the right says **`Create Control`** (NOT `+ Add` or `+ New`). | ? |
| D2 | Look at the toolbar above the table. | Filter chips on left. **NO text-search input** in the middle. Maybe a gear icon + view toggle on right. Primary CTA on far right. | ? |
| D3 | Look at column 0. | Should be a circular checkbox column (~48px wide). | ? |
| D4 | Look at column 1. | The **canonical id for the entity**: Controls=Code, Risks=Title, Frameworks=Name, Policies=Name, Tasks=Title, etc. NOT a generic "ID". | ? |
| D5 | Hover any row. | Background darkens (clearly visible — not 7% alpha). A **brand-coloured left edge** appears on the first cell. Cursor is pointer (if row is clickable). 🚩 NOTE: the original v2-PR-12 claim also said a "chevron-right on the trailing edge" — **that did NOT ship** (found during walk-through). Don't expect to see it. | ? |
| D6 | Single-click a row. | Row's checkbox toggles. (R13-PR14 — single click selects, double-click navigates.) | ? |
| D7 | Double-click a row. | Detail page opens. | ? |
| D8 | Click a sort column header (Code). | Sort indicator changes. Tab in via keyboard — should see a brand focus ring around the header. | ? |
| D9 | Click the gear icon above the table. | A dropdown lists every column. Toggle one off → column disappears. Toggle back on → returns. | ? |
| D10 | Scroll the table — at the bottom. | Pagination footer is sticky. A **soft gradient fade** sits above the footer so the last row doesn't visually crash into it. | ? |
| D11 | Apply a filter that matches nothing (e.g. filter for impossible value). | Empty state appears with title like "No results found" + a **"Clear filters"** CTA. Click it → filter resets. | ? |
| D12 | If you can access an empty tenant: load `/risks` with NO records. | Personality EmptyState: icon + "No risks yet" (no trailing period) + description + primary CTA "Create Risk". | ? |
| D13 | Throttle network in DevTools (Slow 3G) and hard-reload `/controls`. | Skeleton blocks have a **left-to-right shimmer sweep** (gradient overlay moves), NOT a static pulse. The skeleton shape should mimic a table (header row + body rows). | ? |
| D14 | Resize viewport to be very short (~400px tall). | Table body should scroll, **page header + filter toolbar + pagination footer** stay anchored (don't scroll with content). | ? |
| D15 | Verify on all 8 list pages: each row should be the **same height** (~44px). | Especially on Policies — the old multi-line title cell should be gone (description moved to detail page). | ? |
| D16 | Verify on all 8 list pages: column 0 checkbox is **circular** (Radix), NOT square. | Especially Tasks — was historically square. | ? |
| D17 | Click a checkbox. | Row selects. Bulk-action toolbar (if any) shows the selected count. | ? |

---

## E. Detail pages — EntityDetailLayout + MetaStrip + tabs

Test on a few: `/controls/<id>`, `/risks/<id>`, `/policies/<id>`,
`/tasks/<id>`, `/vendors/<id>`, `/assets/<id>`, `/frameworks/<key>`,
`/access-reviews/<id>`, `/audits/cycles/<id>`, `/audits/packs/<id>`,
`/tests/runs/<id>`.

| # | Where + what to do | What you should see / feel | Status |
|---|---------------------|----------------------------|--------|
| E1 | Top-left of any detail page. | **Breadcrumbs only.** NO separate "← Back" link/button. (R10-PR9 ban.) | ? |
| E2 | Below the breadcrumbs. | Page title (large) — eyebrow chip + title + actions cluster on right. | ? |
| E3 | Page header action cluster. | **At most 2 visible buttons + 1 kebab menu.** NOT 4-5 buttons spread out. (v2-PR-14.) | ? |
| E4 | Below the title. | A **horizontal `Label: value · Label: value` strip** (up to 6 visible, "+N more" popover if longer). Should NOT be a vertical sidebar of metadata. | ? |
| E5 | Tab bar below metadata. | Tabs look like the canonical primitive (same chip style, indicator). Tabs with counts (e.g. "Tasks (5)") use tabular digits — the bar should NOT shift sideways when a count goes 9→10. | ? |
| E6 | Click a delete button anywhere. | Confirm dialog button label starts with a canonical verb: **Delete / Remove / Revoke / Discard / Archive / Unlink / Detach / Reject**. NOT generic "Confirm" or "OK". | ? |
| E7 | Required form fields. | Red asterisk next to the label. Screen reader should announce "(required)" — NOT "asterisk". (Open Voice/NVDA if you can.) | ? |
| E8 | Find an inline link in body copy (e.g. "Learn more" in an EmptyState). | Brand-colored text. Hover → **underline appears**. | ? |

---

## F. Dashboard — v2 Premium Polish (R10 + R11)

Visit `/t/<slug>/dashboard`.

| # | Where + what to do | What you should see / feel | Status |
|---|---------------------|----------------------------|--------|
| F1 | Top of dashboard. | A giant **~72px-tall number** (readiness score) with a delta chip (e.g. `+3.2%`) and a primary CTA underneath. Should feel like a front-door moment. | ? |
| F2 | Below the hero. | A **NextBestActionCard** (single CTA + 3 quick-add links) — NOT a 6-button grid. The CTA should be context-aware: "Review N overdue tasks" or "Run readiness check" or similar. | ? |
| F3 | Look at the dashboard tiles overall. | Three archetypes only: number-with-trend / chart / list-with-rows. No 8-different-card-shapes. | ? |
| F4 | Hover any card. | **No lift / scale / shadow.** Border tone shifts only. | ? |
| F5 | Donut chart segments. | Hover a segment → smooth transition (ease-out, not jerky/linear). Colors look like brand/semantic (green / yellow / red), not raw sky / rose / emerald. | ? |
| F6 | Cards. | No drop shadows. Depth comes from background tone only. | ? |

---

## G. Forms + Modals

| # | Where + what to do | What you should see / feel | Status |
|---|---------------------|----------------------------|--------|
| G1 | Click "Create Risk" anywhere. | Modal opens. Form is grouped into **labeled sections** (FormSection primitive), not a long flat list of fields. | ? |
| G2 | Modal action row. | **Cancel on the left, primary on the right.** Cancel is `secondary` variant; primary uses `primary`. Both same size. | ? |
| G3 | Click Cancel. | Modal closes, no save. | ? |
| G4 | Trigger any error (submit form with invalid data). | Error appears with muted bg (NOT saturated `bg-red-500`). Toast appears with consistent copy/dismissal. | ? |
| G5 | Disabled buttons (e.g. submit while form is invalid). | All disabled buttons look identical — same grey + `cursor-not-allowed`. | ? |
| G6 | Open any modal. Tab through. | Focus rings appear on every focusable field. | ? |

---

## H. Status badges + global tone

| # | Where + what to do | What you should see / feel | Status |
|---|---------------------|----------------------------|--------|
| H1 | Any status pill across the product (risk severity, control status, etc.). | **Pill-shaped** (rounded-full). NOT rectangles or rounded-md. | ? |
| H2 | Any status pill. | **Subtle tone** — light bg, slightly stronger text color. NOT solid filled. (R9-PR11.) | ? |
| H3 | Any status pill. | Never brand-orange. Only semantic colors. | ? |
| H4 | Visit `/t/<slug>/tests`. Result column. | Pills say PASS/FAIL/INCONCLUSIVE; should be pill shapes (NOT old `.badge-success` rectangles). | ? |

---

## I. Search palette (⌘K / sidebar pill)

| # | Where + what to do | What you should see / feel | Status |
|---|---------------------|----------------------------|--------|
| I1 | Sidebar — `Search` pill (or press `K` while sidebar focus). | Command palette opens. | ? |
| I2 | Type a single character (e.g. `1`). | Results appear immediately. (Single-char queries allowed since #442.) | ? |
| I3 | Type "patent1" or any asset name. | Asset rows appear in results. | ? |
| I4 | Type any task title. | Task rows appear. | ? |
| I5 | Type any test name. | Test rows appear. | ? |
| I6 | Type a non-existent string. | Empty results — no error, no crash. | ? |
| I7 | Press Esc. | Palette closes. | ? |
| I8 | Open palette → click an asset/task/test result. | Navigates to that entity's detail/list page. | ? |

---

## J. Theme switching

| # | Where + what to do | What you should see / feel | Status |
|---|---------------------|----------------------------|--------|
| J1 | Avatar (top-right) → theme toggle. | App switches between METRO (dark/navy/yellow) and the light theme (cream/orange) instantly. No flash. | ? |
| J2 | Switch theme. | Brand colors swap: yellow ↔ orange. Navy ↔ deep navy. Bg navy ↔ cream. | ? |
| J3 | Switch theme. | Every status pill, badge, button, card stays consistent in BEHAVIOUR — only colors swap. | ? |
| J4 | Print preview of SoA report. | Brand tones (orange/yellow). No raw `slate-*` colors. | ? |

---

## K. Onboarding (if you can trigger it)

| # | Where + what to do | What you should see / feel | Status |
|---|---------------------|----------------------------|--------|
| K1 | Start the onboarding wizard. | Steps shown via a **ChecklistCard** showing progress. Collapses to success state when all done. | ? |
| K2 | Wizard styling. | Brand-coloured (yellow/orange), NOT raw indigo/purple gradients. | ? |

---

## L. Sidebar nav structure (R13 earlier + R14)

| # | Where + what to do | What you should see / feel | Status |
|---|---------------------|----------------------------|--------|
| L1 | Sidebar — section names. | Top: **Board**. Then **Govern** (was "Workspace"), **Comply**, **Manage**. | ? |
| L2 | Sidebar — Comply section. | First item is **Audit** (moved from Manage to top of Comply per R13-PR16). | ? |
| L3 | Sidebar — Manage section. | NO Framework item (dropped per R13-PR12). | ? |
| L4 | Sidebar item labels. | "Review" (was Calendar), "Audit" (was Audits), "Plan" (was Task). | ? |
| L5 | Sidebar — Policy. | Should live under **Comply** (was promoted from Manage). | ? |
| L6 | Sidebar footer. | Theme toggle moved out (now in user menu). Sign-out next to admin gear. | ? |

---

## M. Animations + motion language (R11 + R15)

| # | Where + what to do | What you should see / feel | Status |
|---|---------------------|----------------------------|--------|
| M1 | Click any button anywhere. | Visible compression (~3% scale-down) on press. Spring back on release. | ? |
| M2 | Hard-reload any page. | Content fades in (not a pop). | ? |
| M3 | Hover any clickable card. | NO lift, NO scale, NO shadow. Only bg / border color shifts. | ? |
| M4 | Set "prefers-reduced-motion: reduce" (OS accessibility setting). | All animations should still complete instantly (animation-duration: 1ms). No motion-driven UI is broken — the underlying state machine still works. | ? |

---

## What's NOT in this checklist

- The 80-item Roadmap-3..6 "audit log" detail items (those need their own pass)
- Backend / API / security work (R-series doesn't audit security PRs)
- Visual regressions you spot incidentally (just flag them, we'll triage)
- Print views (SoA print is one row above; others not covered)

## Reporting back

When done, share this file with annotations OR a quick "row N: X" list.
Anything `🚩 BROKEN`:
- I'll diagnose from code first (same shape as the active-band v2 case)
- If it's a real bug, ship a focused fix-PR
- If it's a stale claim (like v2-PR-12 chevron), update the audit doc
  to reflect what actually shipped
