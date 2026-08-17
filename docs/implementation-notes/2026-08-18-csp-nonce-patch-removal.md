# 2026-08-18 — Removing the inert CSP nonce patch

**PR:** #1972 — fix(csp): remove the inert next nonce patch, assert the property instead

## What was removed

- `patches/next+16.2.7.patch`
- `tests/guards/csp-nonce-component-scripts-patch.test.ts`

Replaced by `tests/e2e/csp-nonce-coverage.spec.ts`, which asserts the property
users depend on: every executable `<script>` on an authenticated page carries a
nonce.

## The original bug was real

2026-05-14: one `_next/static/chunks/*.js` tag rendered without a nonce on every
authenticated page. CSP `strict-dynamic` blocked it and the R16 donut chart
rendered as a thin orange crescent. The diagnosis was correct and well
documented — `createComponentStylesAndScripts` omits `nonce: ctx.nonce` where its
sibling `getLayerAssets` passes it.

The deleted guard's own docblock records the verification: *"Verified by re-curl
after manually patching the bundled prod runtime — 0 unnonced scripts, fix
confirmed."* Note **bundled prod runtime**. The author knew which file mattered.

## Why the committed fix never covered it

The docblock claims the patch covers *"all four bundled prod runtimes in
`dist/compiled/next-server/app-page*.prod.js`"*. The committed patch has **two
hunks, both on unbundled sources**:

```
dist/server/app-render/create-component-styles-and-scripts.js
dist/esm/server/app-render/create-component-styles-and-scripts.js
```

`dist/server/route-modules/app-page/module.compiled.js` has five branches; only
`NEXT_RUNTIME === 'edge'` loads the unbundled `./module.js`. Every Node branch
requires a compiled bundle, and those bundles **inline** the function — the
string `create-component-styles-and-scripts` appears zero times in all six of
them. So the patched files are never loaded when rendering an app page.

Proven by byte-identity: extracting the pristine `next@16.2.12` tarball and
comparing, **all six `app-page*.runtime.*.js` bundles are identical to stock
npm.** The only difference between pristine and installed is the two unbundled
files, +2 lines.

Most likely the bundle hunks were lost to a `patch-package` regeneration across a
Next version bump, leaving the prose describing an intent the file no longer
carried.

## Three independent false signals

1. **Wrong bundle.** Production runs `next start` with `TURBOPACK` unset
   (verified in the running container), loading `app-page.runtime.prod.js`. The
   guard read `app-page-turbo.runtime.prod.js`.
2. **Wrong function.** Its `nonce:` regex matched the inlined `getLayerAssets`,
   which upstream already nonces — so it passed against a file byte-identical to
   stock.
3. **Absent in production entirely.** Inside `inflect-app-1`: no `nonce:
   ctx.nonce`, no `patch-package`, no `patches/`. The Dockerfile copies only
   `package.json` + lockfile before `npm ci`, so `postinstall` runs with no
   patches directory and silently no-ops. Tracked separately — that trap applies
   to any future patch.

## Why production is nevertheless clean

Not the patch. `next build --webpack` (2026-06-05) is the real fix: webpack's
client-reference manifests never populate `entryJSFiles`, so
`createComponentStylesAndScripts` emits no script elements at all.

Measured live: `/login` 31 `<script>` tags, **0 unnonced**; `/no-tenant` 13,
**0 unnonced**.

That is a build-flag property, not a code fix. Moving back to Turbopack — or an
upstream change that starts emitting `entryJSFiles` under webpack — brings the
unnonced tag back, silently.

## Decisions

- **Deleted rather than repaired.** The guard's central assertion could not be
  made truthful: pointing it at the right bundle and bounding it to
  `createComponentStylesAndScripts` would FAIL, because that site is unnonced and
  always has been. Repair would have meant patching the compiled bundles *and*
  fixing the Dockerfile — building machinery to fix a problem that `--webpack`
  already solves.

- **Replaced a mechanism ratchet with a behavioural test.** The deleted guard
  validated the *diagnosis* (is a patch present? does a bundle contain a
  string?). The spec validates the *remedy* (do all scripts carry a nonce?) and
  fails when the real regression returns, whichever file or flag carries the fix.
  This is the failure mode CLAUDE.md's epic-ratchet section describes, in a
  security control rather than a UI one.

- **The spec pins the CSP header too.** Asserting "no unnonced scripts" is
  vacuous if `script-src` stops requiring a nonce, so the header is asserted to
  still carry `'nonce-…'` and `'strict-dynamic'`.

- **Unblocks #1961.** That PR needs the patch regenerated for next 16.3.1;
  regenerating an inert patch would have been pure waste, and deleting the patch
  removes the failure that takes down all 11 of its checks at install time.
