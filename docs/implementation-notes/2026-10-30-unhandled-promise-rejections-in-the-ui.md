# 2026-10-30 — the nine unhandled promise rejections in the UI

**Issue:** found while measuring #4585

## What these are

#4585 asks whether `no-floating-promises` should cover the UI, and framed the
~165 sites as "overwhelmingly React event handlers and effects, where the called
function handles its own errors", with an "expected defect yield close to zero".

Measured: of 166 sites, **157 are safe by construction** — 56 SWR revalidations
(a fetcher rejection surfaces through SWR's own `error` state), 83 calls to
loaders that own their errors, 16 async IIFEs that already `catch`, 2 chains with
a `.catch`. The framing holds for those.

**Nine were genuinely unhandled**, and two left a page in a permanent loading
state. They are fixed here. The scope decision on #4585 is untouched and does
not depend on this.

## The two that hung

- `mapping/page.tsx` — `fetch(...).then(r => r.json()).then(setData)` with no
  `.catch`, and the component renders `if (!data) return <loading…>`. A network
  rejection therefore produced an animated skeleton, for ever, with no error.
  Also did not check `r.ok`, so a 500 returning HTML threw in `json()` down the
  same path.
- `templates/page.tsx` — an async IIFE whose last statement was
  `setLoading(false)`. A rejection skipped it.

## The others

| site | was | now |
| --- | --- | --- |
| `notifications/page.tsx` | rejection left the list at `[]`, rendering as "no notifications" | an error state, because an empty list and an unreachable server are different facts |
| `TraceabilityPanel.tsx` ×3 | non-ok already yielded `[]`; a rejection went nowhere | `.catch` makes a rejection behave like the non-ok case it already handles |
| `install/page.tsx` | rejection left the PREVIOUS pack's preview under the new pack's name | `.catch(() => setPreview(null))`, mirroring its non-ok branch |
| `readiness/page.tsx` | `.finally` cleared the spinner, so it degraded rather than hung — but the rejection still floated | `.catch` reaches the same empty state deliberately |
| `FileDropzone.tsx` | `onAllSettled` was the last statement of an unguarded IIFE, so a throw from `runOne` meant the consumer was never told the batch finished | `try/catch/finally` — the callback always fires |

Two pages gained an error message, following the established
`<section>.loadError` convention (`assets.list.loadError` is the model), in
English and Bulgarian.

## Decisions

- **No new error surface in `TraceabilityPanel`.** It is embedded in five detail
  pages and its existing contract for "could not read the options" is already an
  empty picker. Making a rejection behave like the non-ok case it already
  handles is the smaller, truer change.

- **`FileDropzone`'s `catch` is not redundant with its `finally`.** `finally`
  makes the callback fire; the IIFE's promise still rejects and nothing awaits
  it. The `catch` is also defensive rather than expected — `runOne` has its own
  try/catch and converts a failed upload into a settled entry, so a throw
  reaching the loop is a bug in it.

- **The error-state reset rides the SUCCESS path, not the effect body.** A
  synchronous `setFailed(false)` is what `react-hooks/set-state-in-effect` warns
  about; it is only needed so a later successful read clears a previous failure,
  which the success handler can do. No new lint warnings.

- **No `void` added anywhere.** The rule flags a floated promise regardless of
  internal handling, so the 16 already-safe IIFEs would each need one if it were
  enabled. That is #4585's decision, and doing two of sixteen would be arbitrary.
  Hence the site count only falls 166 → 159: this change fixes *unhandled
  rejections*, which is not the same question as *satisfying the rule*.

## Two traps hit while doing this, both from the repo's own notes

**`json.dump(..., indent=4, sort_keys=True)` rewrote both message files** —
28,494 and 28,538 lines — because they are 2-space indented and in insertion
order. Reverted and inserted textually instead: 4 lines, key parity held at
12,338 both sides. The hazard is written down in
`json-roundtrip-reformats-the-catalogue`.

**A `/* … */` comment tripped an unrelated ratchet.** Adding one inside
`FileDropzone.tsx` took `border-tone-budget` from 106 to 108 without adding a
single border class: that guard strips comments with a non-greedy
`/\*[\s\S]*?\*\//`, and inserting a block comment shifts the boundaries, so two
previously-stripped occurrences became visible. Diagnosed by counting committed
content per ref (106 on both) against the filesystem walk (108), then per file
(`FileDropzone` disk=3, head=1). Using `//` instead makes the change
count-neutral. The fragility is filed separately — a counting ratchet whose
answer depends on where an unrelated comment sits is a false-positive generator,
and it cost a long diagnosis here.
