# 2026-08-19 — the E2E render probe that could never succeed on mobile

**Commit:** `(this PR)` fix(e2e): make the render probe viewport-independent

## Design

`loginAndGetTenant` ends with a retry loop whose job is "reload if the server
was still compiling":

```ts
const hasSidebar = await page.locator('aside').isVisible().catch(() => false);
if (hasSidebar) break;
```

`aside` is the desktop sidebar. It is `display:none` below `md` **by design** —
which is precisely what `responsive.spec.ts`'s
`sidebar hidden and hamburger visible` test asserts.

So at any mobile viewport the probe **can never succeed**. Every mobile test
exhausted all three retries and performed three redundant full navigations,
each with two `networkidle` waits, on a page that had already rendered
correctly the first time. Desktop tests break out immediately and never enter
that path.

The probe was asking "is this a wide screen?" while the loop meant "did the
page render?". `main` is the content landmark the tenant layout renders at
every width, so it answers the question actually being asked.

## Measured

`responsive.spec.ts`, next 16.2.12, same machine and seeded database:

| | before | after |
| --- | --- | --- |
| `sidebar hidden and hamburger visible` | 10.2s | **4.7s** |
| `vendors has no horizontal overflow` | 9.6s | **4.2s** |
| full spec (10 tests) | — | **1.0m, 10 passed** |

Roughly 2x per mobile test, on every CI run, for as long as the helper existed.

## How it was found

Chasing the `next` 16.3.1 quarantine (#1973 / #2001). Under 16.3.1 those
redundant navigations stop completing and the tests time out at 3 minutes
instead of merely wasting time. Fixing the probe takes
`vendors has no horizontal overflow` from a 3.1m timeout to **4.2s** on
16.3.1 — a 45x change identifying the probe as the dominant amplifier.

A residual 16.3.1 problem remains on the dashboard route and is tracked
separately. **This fix is independent of it**: the probe is wrong on 16.2.12
too, and the wasted work is real today.

## Files

| File | Role |
| --- | --- |
| `tests/e2e/e2e-utils.ts` | probe `aside` → `main`; `hasSidebar` → `rendered`; rationale in-place |
| `tests/guards/e2e-render-probe-viewport-independent.test.ts` | the invariant + two negative cases |

## Decisions

- **A structural guard, deliberately, and this is the case for it.** No
  behavioural test can catch this: reverting to `aside` leaves the E2E suite
  green, just slower. The bug is invisible as a failure and shows up only as
  time — which is why it survived. The guard is named for the invariant
  ("a render probe is viewport-independent"), not for this diff.

- **It also rejects the mirror-image mistake.** Probing
  `[data-testid="nav-toggle"]` — the hamburger, hidden on *desktop* — would
  break the desktop tests the same way. Both are asserted.

- **It reads RAW source, no comment stripping.** The first version stripped
  comments and the stripper silently ate the anchor: `e2e-utils.ts` contains
  the text `/*` inside a `//` comment, which a `/\*[\s\S]*?\*\/` regex treats
  as a block opener and swallows through to the next close. Every downstream
  assertion then passed against an empty string. The patterns used instead
  require a real `locator('x').isVisible` call, which prose cannot satisfy.

- **The slice is anchored, with an ordering guard.** `functionBodyOf` could not
  bound this function, and a file-wide regex matched the wrong site —
  `gotoAndVerify` also probes, via a `contentSelector` *parameter*, which is
  correct there and is not a literal any test can check. The loop is bounded by
  two once-only anchors plus an explicit `end > start` assertion, because a
  reordered file yields a backwards slice that is silently empty.
