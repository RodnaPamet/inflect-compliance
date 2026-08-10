# 2026-08-10 — The js-yaml floor that stopped patching, and what the pack-freeze "flake" actually is

**Commit:** `<pending>` fix(deps): raise the js-yaml floor past CVE-2026-59870; test the pack-freeze flow

Two follow-ups from the Dependabot fix (#1841). One is a security floor that
had quietly stopped being a floor. The other was filed as an E2E flake and is
not one.

## 1 — The js-yaml override no longer patched anything

`scripts/check-override-freshness.mjs` reports override floors that upstream has
moved past. It was emitting an `::error` that nothing acted on, because the
workflow that runs it is scheduled and non-blocking:

```
Override floor still vulnerable: js-yaml ^4.3.0: the override floor 4.3.0 is
itself affected by GHSA-5p4m-2wfm-xmqj (>= 4.0.0, < 4.3.1)
```

The registry recorded `GHSA-52cp-r559-cp3m` (CVE-2026-59869), fixed at 4.3.0 —
which is exactly where the floor sat. That was correct when written. Then
`GHSA-5p4m-2wfm-xmqj` (CVE-2026-59870, high — quadratic CPU in `!!omap`) landed
covering `>= 4.0.0, < 4.3.1`, and the floor became a floor at a vulnerable
version.

**This is the failure mode the freshness script exists to catch, and it caught
it.** The only thing missing was someone reading a non-blocking workflow.

Four things move together, which is why this wasn't a one-line bump:

| | before | after |
| --- | --- | --- |
| range key | `js-yaml@>=4.0.0 <4.3.0` | `js-yaml@>=4.0.0 <4.3.1` |
| spec | `^4.3.0` | `^4.3.1` |
| advisory | `GHSA-52cp-r559-cp3m` | `GHSA-5p4m-2wfm-xmqj` |
| `patchedFrom` | `4.3.0` | `4.3.1` |

The **range key** matters as much as the spec: keyed at `<4.3.0`, the override
no longer selected the 4.3.0 instances at all, so raising only the spec would
have changed nothing.

The same advisory has a second branch — `>= 3.0.0, < 3.15.1` — and the tree
carries a 3.x instance under `@istanbuljs/load-nyc-config`, pinned there
separately because that consumer uses the 3.x API. Its nested pin goes
`^3.15.0` → `^3.15.1`.

Result, every vulnerable instance moved:

```
4.3.0  → 4.3.1   @eslint/eslintrc
3.15.0 → 3.15.1  @istanbuljs/load-nyc-config
4.3.0  → 4.3.1   cosmiconfig
5.2.2            (root — outside both ranges)
```

## 2 — The pack-freeze "flake" is a 500

Two E2E specs intermittently failed at the freeze step, and the obvious suspect
was the P3 migration of that page's seven writes to `useTenantMutation` — the
flow had changed, and it had shipped with no rendered test.

**It isn't the client.** `tests/rendered/audit-pack-freeze.test.tsx` drives the
real component: freeze POSTs once, the badge reaches Frozen, the GET-only
relations (`items` / `cycle` / `_count`) survive the response, and a failed
freeze leaves the badge on Draft rather than an unsaved Frozen. All green,
deterministically.

The evidence that settles it is in the spec itself. `audit-readiness.spec.ts`
already asserted the response status, and that is the line that failed:

```
135:  expect(response.status()).toBe(200);
      Expected: 200
      Received: 500
```

The server log for that request:

```
POST /api/t/audit-readiness-…/audits/packs/… → 500
DecryptIntegrityError: encryption-middleware: failed to decrypt Task.description
  (v2) with an available tenant DEK — wrong key, corrupt row, or a write made
  under a mismatched tenant context
```

Freeze is the request most likely to hit it, not the cause of it: freezing
snapshots every pack item in one transaction, so it decrypts more rows than any
other single call.

### It is endemic, not new

Counting `DecryptIntegrityError` 500s per E2E run:

| run | count | E2E result |
| --- | --- | --- |
| `f72d8699` (main) | 6 | **green** |
| this branch | 9 | red |

They occur on green runs too, spread across `Task.description`, `*.note`,
`*.contentText` and `*.description`, on GET and POST, across many tenants.
Playwright retries absorb them until a run is unlucky enough to spend all three
on the same spec. So the "flake" is a standing defect with a retry mask over it.

**Not fixed here, deliberately.** The message names three candidate causes
(wrong key / corrupt row / write under a mismatched tenant context) and
choosing between them is an Epic B investigation — DEK resolution, the
`$allOperations` extension, and the AsyncLocalStorage tenant context under the
E2E fixture's rapid tenant creation. Guessing at it would be worse than
recording it precisely.

## Files

| File | Role |
| --- | --- |
| `package.json` | js-yaml range key + spec, and the 3.x nested pin |
| `tests/guards/override-registry.json` | advisory + `patchedFrom` for the superseding CVE |
| `tests/rendered/audit-pack-freeze.test.tsx` | new — the freeze flow, and the P3 coverage gap it closes |

## Decisions

- **The range key moved with the spec.** Raising `^4.3.0` → `^4.3.1` alone
  would have left the key selecting `<4.3.0`, matching nothing, and the
  guard would still have passed — an override that reads like protection and
  protects nothing is the exact shape `overrides-effective` was written against.

- **The rendered test asserts the relations, not just the status.** The freeze
  response carries no `items` / `cycle` / `_count`, so a cache write of the
  response verbatim would blank the page *while still reading "Frozen"*. A test
  that checked the badge alone would pass through that.

- **Confetti is stubbed via the hook's own seam.** Reaching FROZEN fires the
  Epic 62 celebration, and jsdom has no canvas, so `getContext` returns null and
  confetti throws on `clearRect` — an unhandled exception that fails the test
  for a reason unrelated to freezing.
