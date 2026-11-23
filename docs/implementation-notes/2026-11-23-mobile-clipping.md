# 2026-11-23 — Mobile clipping: SettingRow, wrapping code, the header's title row

Issues #5874, #5875 and #5879, part of the mobile epic #5868. All three move
the same metric, `clipped` (content cut at the right edge of a phone, where the
app shell's `overflow-x-clip` hides it instead of scrolling it), so they ship
together.

## Design

Three shared causes, each fixed once in a primitive and then adopted.

**Title-plus-control rows (#5874).** Settings-style rows were hand-rolled as
`flex items-start justify-between` with a text block that could not shrink and
a control cluster that could not wrap. On a phone the control went off the
right edge, or the title was squeezed to one word per line beside it.
`<SettingRow>` (`src/components/layout/SettingRow.tsx`) owns the geometry:

```
below sm:  [leading][title · adornment]      from sm:  [leading][title · adornment]   [control]
                    [description]                              [description]
           [control, wrapping]
```

The text column is `min-w-0 flex-1`; the control cluster is `flex-wrap`,
`self-start` (natural width on a phone) and `sm:shrink-0`. Slots: `leading`,
`title`, `titleAdornment`, `description`, `children` (more text-column
content), `control`; `align` sets the cross-axis alignment from `sm` up. It
owns no container, so it drops into a `ShadedRow`, a `Card` or a `<header>`.

**Unbroken strings (#5875).** URLs, redirect URIs, environment variable names
and digests have no space to break at. One rule in `src/app/globals.css`,
`overflow-wrap: anywhere` on `code`, `samp` and `.font-mono`, in `@layer base`.

**The page header's title row (#5879).** The heading and the record pager share
one flex row; the heading could not shrink below its longest word. The heading
is now `min-w-0 wrap-break-word` and the adornment sits in a `shrink-0` box.
The policy page also wrapped its title in an inline `truncate` span, which only
kept the title on one line; it is `block sm:truncate` now.

## Files

| File | Role |
|---|---|
| `src/components/layout/SettingRow.tsx` | The new primitive |
| `admin/ai-features/{AiFeaturesClient,AgentEnginesSection,AgentOversightSection}.tsx` | Rows adopt `SettingRow` |
| `admin/notifications/page.tsx`, `admin/risk-matrix/RiskMatrixAdminClient.tsx`, `admin/scim/page.tsx`, `risks/correlations/page.tsx` | Title-and-actions headers adopt `SettingRow` |
| `src/components/onboarding/OnboardingBanner.tsx` | The banner adopts `SettingRow` (with `leading`) |
| `org/[orgSlug]/(app)/settings/OrgAgentSwitchesSection.tsx` | The switch row wraps; its badge drops under the label |
| `src/app/globals.css` | The code / mono wrapping rule |
| `src/components/layout/PageHeader.tsx` | The title row's shrink and no-shrink |
| `policies/[policyId]/page.tsx` | The title span wraps on a phone |
| `tests/e2e/mobile-ratchet.ts` | Baselines re-measured |
| `docs/new-subsystem-checklist.md` | §6 names both rules |

## Decisions

- **`anywhere`, not `break-word`.** Only `anywhere` lowers min-content width,
  and most of the clipped identifiers sat in flex rows (`<dd className="font-mono">`
  beside a `<dt>`), where `break-word` changes nothing. Text that fits never
  breaks, and table cells are `whitespace-nowrap` or `truncate`, so wide screens
  are unchanged. `kbd` is left out: a shortcut should never split.
- **The rule is in `@layer base`.** A utility on one element still overrides it
  (`wrap-normal`, `whitespace-nowrap`), and the globals-layering guard holds.
- **The title row's heading does not grow.** `flex-1` would have kept the pager
  on screen too, but on a wide screen it would have moved the pager to the far
  end of the row. `min-w-0` alone lets the heading shrink and keeps the pager
  beside it.
- **Desktop layouts kept where a page relied on wrapping.** The risk-matrix
  header wraps its buttons under a long description on desktop; its text column
  is `sm:flex-initial` so that still happens, rather than the buttons moving
  beside the text.
- **The org switch row is not a `SettingRow`.** Its control (the switch) leads
  the label, and moving it to the right would change the desktop layout; the
  row wraps instead, with switch and label kept together.
