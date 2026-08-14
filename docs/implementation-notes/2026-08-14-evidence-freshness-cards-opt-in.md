# 2026-08-14 — Evidence freshness cards are opt-in (correcting the fold)

**Commit:** `(this PR)` fix(evidence): the freshness cards fold INTO the gear, not just under it

Supersedes the storage-key section of
[`2026-08-14-evidence-gear-fold-freshness.md`](2026-08-14-evidence-gear-fold-freshness.md).
That note is left intact — it records what #1913 actually did.

## What was wrong

The ask was to "fold the four extra filter cards into the gear icon". #1913
registered them with the gear and rendered the strip from `visibleCards`, but
left all eight **default-visible**. The result looked identical to before —
eight cards over two rows — and changed only whether they *could* be hidden.
The user's report was exact: *"the evidence page still shows 8 kpi cards"*.

Registering a card and folding it away are different things, and
`defaultVisible: false` is the entire difference. Nothing else in the file
distinguishes them, which is why the first attempt passed every test it had.

## The change

Four lines: `defaultVisible: false` on `current` / `expiring` / `expired` /
`needs_review`. The page opens on the status four — one full
`grid-cols-2 md:grid-cols-4` row — and the freshness four are unchecked rows in
the gear popover.

### The `-v2` storage key came back out

#1913 bumped the key to `inflect:filter-vis:evidence-v2`, and that reasoning
was sound **for default-visible cards**: `reconcileOrder` drops dead ids and
never appends, so newly-added visible cards would have stayed hidden for anyone
who had ever touched the gear.

Opt-in cards invert that. They are precisely the case the hook already handles
— a persisted status-card order survives untouched, and the four new cards
appear as unchecked rows via `buildChecklistItems`. No migration is needed, so
the key bump became pure cost: it would discard every user's saved card order
for nothing. Reverting is safe because the version that wrote `-v2` never
reached a deployed environment — production was still on 1.846.15 when this
landed, so no `-v2` value exists in any browser.

### This depends on #1909

`defaultVisible: false` only works because
`fix(filter): opt-in cards were unreachable through the gear (#1909)` changed
the hook to reconcile against **every registered card** rather than only the
default-visible ones. Before that, `onToggle` wrote the opt-in id to storage
and the next render dropped it again — the checkbox would not even check. Had
this fold shipped before #1909, the freshness cards would have been not merely
hidden but unreachable.

## Files

| File | Role |
| --- | --- |
| `src/app/t/[tenantSlug]/(app)/evidence/EvidenceClient.tsx` | Four `defaultVisible: false` flags; storage key reverted; two comments corrected |
| `tests/guards/kpi-sparkline-canonical.test.ts` | New Evidence block: the freshness four are opt-in, the status four are not, and the key stays unversioned |

## Decisions

- **The status four stay default-visible.** They answer "where is my evidence
  in the review workflow", which is the page's primary axis. Review-currency is
  a real way to work but not the common one.
- **The test asserts the flag, not the count.** A card count would pass while
  the wrong four were hidden. Per-id assertions name which axis folds.
- **No i18n or filter-def change.** The retention `tab` filter and every label
  from #1913 are unaffected; this is purely about default visibility.
