# 2026-09-29 — tldraw pinned to 3.x, and the advisory that turned out to be stale

**Commit:** see `feat/2960-pin-tldraw-3x`

## Design

Adopting the tldraw canvas SDK (#2960) meant answering two questions that looked
like one. Both were settled by measurement rather than by reading the vendor's
marketing pages, and both answers were the opposite of the first-pass reading.

### 1. The licence flips at 4.0.0

#2958 was originally written from `LICENSE.md` on tldraw's `main`, concluded
"production use is banned without a paid key", and made a commercial licence the
roadmap's Gate 1 — the one item with procurement lead time. That was accurate
about **5.x** and wrong as a statement about tldraw.

Read at the git tags, the terms change completely at 4.0.0:

| | 3.x (through 3.15.6) | 4.x / 5.x |
|---|---|---|
| grant | "commercial or non-commercial projects" | "Development Environments" |
| production | permitted | banned without a paid key |
| watermark | must not be removed | no watermark clause at all |
| a key buys | watermark removal | permission to deploy |
| telemetry | none | "may collect and transmit usage data" |

The boundary was located by probing every tag for three marker clauses rather
than inferred from two endpoints. `v3.0.0` and `v3.15.6` are byte-identical
apart from one URL becoming a markdown link.

3.x is also still maintained: 3.15.6 shipped **2026-02-11**, five months after
4.0.0 (2025-09-18).

### 2. The 28 advisories are one advisory, and it is a false positive

Installing tldraw 3.15.6 took `npm audit --omit=dev` from 0 findings to 28, all
`@tiptap/*` nested under tldraw, all one advisory: **GHSA-cp6q-959q-f8rh**,
`mergeAttributes()` turning an own `__proto__` key into inherited executable DOM
attributes (CWE-79 + CWE-1321).

The advisory's affected range is `>=2.0.0-alpha.0 <3.30.4`, and tldraw 3.x
declares `@tiptap/* ^2.9.1`, which can never reach 3.30.4. That reads as
"permanently vulnerable, no in-range remedy" — and it is wrong.

**tiptap backported the fix to the 2.x line in 2.27.3, published 2026-09-04 —
nine days AFTER 3.30.4 landed on 2026-08-26.** The advisory's upper bound was
never amended, so `npm audit` reports a version that carries the fix.

Verified three ways rather than one:

- **Read** — the `__proto__` guard is present in both the cjs and esm builds of
  2.27.3, character-for-character the same logic as patched 3.31.3.
- **Executed** — the advisory's own attack shape (an own `__proto__` key from
  `JSON.parse`) through the real 2.27.3 `mergeAttributes` leaves
  `Object.prototype` untouched and lands `__proto__` as an own property. A naive
  merge of the same payload **does** pollute, which is the positive control that
  makes the first result mean anything.
- **Held** — `tests/guards/tiptap-proto-merge-is-fixed.test.ts` runs that attack
  against every `@tiptap/core` in the tree on every CI run.

## Files

| file | role |
|---|---|
| `package.json` / `package-lock.json` | `tldraw: ^3.15.6` |
| `security/audit-allowlist.json` | the GHSA-cp6q-959q-f8rh exemption, with its reason, verification, reachability and upgrade plan |
| `tests/guards/tiptap-proto-merge-is-fixed.test.ts` | executes the attack against every `@tiptap/core` in the tree; fails below the 2.27.3 backport floor |
| `tests/guards/dependency-risk-review.test.ts` | `tldraw: { major: 3 }` — a CEILING, unlike every other entry |
| `docs/dependency-risk-review.md` | the verdict, plus a new ground (d) admitting licence-bound packages |

## Decisions

- **`^3.15.6`, not an exact pin.** An earlier draft demanded `3.15.6` exactly, on
  the stated grounds that a caret "resolves to 4.x on a routine `npm update`". It
  does not — a caret on a `>=1.0.0` version is bounded by its major, so
  `^3.15.6` and `^3` both exclude 4.0.0. The exact pin also contradicted this
  repo's own written policy ("It does NOT pin exact versions — in-major
  patch/minor bumps stay free"). Fighting a convention on a false premise is the
  worst of both, so the caret stands.

- **No new pin guard.** `REVIEWED` already asserts exact major equality, so one
  line does the whole job — and a new guard would have needed registering in
  `dependency-governance-integrity.test.ts`, whose registry asserts
  `toHaveLength(5)`.

- **The exemption needed a guard, because it is only honest while the resolved
  version carries the fix.** `^2.9.1` admits 2.9.1 through 2.27.x, and every 2.x
  *below* 2.27.3 is genuinely vulnerable. Without the guard, a lockfile change
  could drop the tree onto a real hole that the allowlist then waves through —
  invisibly, because `npm audit` reports the same advisory either way and the
  gate keeps passing. **The allowlist entry answers "is this advisory stale?";
  the guard answers "is the code actually fixed?".** Only the second is about
  users.

- **The guard executes rather than greps.** A grep for `__proto__` passes on a
  file that merely mentions it, including one where the guard was refactored
  into something that no longer works.

- **`overrides` to tiptap 3 was tested and rejected.** It resolves cleanly,
  takes the audit to 0, builds (893 modules, no missing exports), mounts the
  editor, mounts and focuses tiptap, accepts typed text, applies bold marks and
  survives an edit-mode round trip — then **silently breaks the second rich-text
  edit session**: ProseMirror never remounts, keystrokes are discarded, nothing
  throws. Deterministic at 900/1800/3000 ms settle, against an unoverridden
  control passing all three.

  The control is the part worth keeping. The failure first appeared in a
  sequenced run and read exactly like a probe race — in isolation the same case
  passes at every wait. Only running the identical script against unoverridden
  tiptap 2 made it attributable (8/8 baseline, 7/8 override). Without that
  comparison it would have been filed as a test bug and a silent editor break
  would have shipped.

- **Two probe failures worth recording**, because both returned confident wrong
  answers. Grepping the `.d.ts` for exported symbols reported `createShapeId`
  absent from both majors minutes after it had been executed — `tldraw`
  re-exports through `@tldraw/editor` and `@tldraw/tlschema`, so the text was
  never going to contain it; resolving the module with the TypeScript compiler
  gave the real lists (1225 vs 1485 exports, 1158 common). And the first
  `everyTiptapCore` walker found 2 of 3 copies, missing
  `@tldraw/editor/node_modules/@tiptap/core`, because a **scoped** package's
  nested `node_modules` sits one level deeper than an unscoped one. Its
  `length > 0` population check passed and hid it — which is why that assertion
  now names the nested copy specifically.
