# 2026-07-28 — Retire the dead button-material tokens

**Commit:** `<sha>` chore(tokens): retire the carbon / ambient / iridescent / aura / glass token suites

Completes the follow-up named in
`2026-07-28-still-surface-buttons.md`, which deliberately left the superseded
token suites in place to keep that diff scoped to the material swap.

## Design

Still Surface replaced the R19→R24 button material but did not remove the
tokens the old material stood on. This removes them.

**Method — reference count, not assumption.** Every `--btn-*` token in
`tokens.css` was counted against the rest of `src/`:

| Token family | Refs outside tokens.css | Action |
|---|---|---|
| `--btn-carbon-*` (4) | 0 | removed |
| `--btn-ambient-*` (4) | 0 | removed |
| `--btn-aura-*` (2) | 0 | removed |
| `--btn-glass-*` (8) | 0 | removed |
| `--btn-iridescent-gradient` | 1 — a prose comment only | removed |
| `--btn-gradient-primary` | **2 — one live** | **kept** |
| `--ctrl-edge-*` | live (form controls) | kept |
| `--btn-still-*` | live (Still Surface) | kept |

The count is why `--btn-gradient-primary` survived. It reads as a button
token and every button had stopped using it, but
`dashboard/PostureHeroCard.tsx:39` paints it as gradient TEXT
(`bg-[image:var(--btn-gradient-primary)] bg-clip-text text-transparent`).
Removing it by family would have silently broken the dashboard hero — the
kind of failure no button test would catch.

Whole documented blocks were removed rather than bare declarations, so no
orphaned rationale comments describe tokens that no longer exist. 268 lines
across both themes.

## Files

| File | Role |
|---|---|
| `src/styles/tokens.css` | 18 dead tokens + their documentation blocks removed from both themes. |
| `tests/guards/r24-pra-glass-token-foundation.test.ts` | Retired — its entire subject was the `--btn-glass-*` suite. |
| `tests/guards/b10-create-button-dark-contrast.test.ts` | Fill-alpha assertion rewritten against the opaque gradient. |

## Decisions

- **`--btn-gradient-primary` kept despite the naming.** It is now used by
  exactly one non-button surface. Renaming it to something surface-neutral
  would be tidier but touches a live dashboard style for zero user-visible
  gain; leaving it named for its origin is the smaller risk. Worth revisiting
  if a second consumer appears.

- **B10's contrast assertion was rewritten, not deleted.** It pinned a
  specific alpha (`rgba(232,185,4,0.85)`) on a token that no longer exists —
  but the invariant underneath it (the primary label must sit on a solid
  brand surface, not a translucent wash that lets page tone bleed through) is
  still real. Still Surface satisfies it structurally by making the fill an
  opaque gradient, so the assertion now checks that the brand stops are used
  AND that the translucent tokens cannot return.

- **The Still Surface note was not edited.** It states these tokens "were
  left in place" and names this as follow-up work. That was true when
  written, and `docs/implementation-notes/` is historical-by-path and
  read-only by convention — so this note supersedes that paragraph rather
  than rewriting history.
