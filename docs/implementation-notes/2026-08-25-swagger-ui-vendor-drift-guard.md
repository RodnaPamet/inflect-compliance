# 2026-08-25 — Swagger UI vendored assets: close the drift, then make it detectable

Closes #2125.

## The measurement

`public/swagger-ui/` holds three committed `swagger-ui-dist` assets that
`/api/docs` self-hosts. They were byte-identical to **5.17.14** —
verified against the registry tarball, not inferred:

| file | committed sha256 | swagger-ui-dist@5.17.14 |
| --- | --- | --- |
| `swagger-ui.css` | `40170f0e…` (152,071 B) | identical |
| `swagger-ui-bundle.js` | `c2e4a9ef…` (1,452,753 B) | identical |
| `swagger-ui-standalone-preset.js` | `33b7a6f5…` (230,293 B) | identical |

`package.json` declared **5.32.14**. Fifteen minor versions and six
dependabot bumps of distance, accumulated since `352aab35c` (2026-06-26)
— the commit that both self-hosted the assets and declared 5.17.14.

## Design

The one-off re-vendor is the small half. The structural half is that
three facts must agree, and until now nothing compared any pair of them:

```
declared            installed              served
package.json   ==   node_modules/     ==   public/swagger-ui/
5.32.14             swagger-ui-dist        the bytes a browser executes
```

`tests/guardrails/vendored-swagger-ui-matches-dependency.test.ts` asserts
both links. Neither alone is sufficient: `declared == installed` alone
still lets stale bytes ship, and `installed == served` alone is
satisfiable by a hand-edited `package.json` that `npm install` never saw.

The guard also pins the asset *set* three ways — what `route.ts` links,
what `scripts/copy-swagger-ui.js` copies, and what is committed must be
the same list. A route that starts linking a fourth asset nothing
vendors is a 404 in the browser; a committed file nothing links is dead
weight in the image.

Fixing any failure is one command, and the failure message says so:
`npm run swagger-ui:vendor`, then commit `public/swagger-ui/`.

## Files

| file | role |
| --- | --- |
| `public/swagger-ui/*` (3 files) | re-vendored 5.17.14 → 5.32.14 |
| `tests/guardrails/vendored-swagger-ui-matches-dependency.test.ts` | the guard: declared == installed == served, plus the asset-set pin |
| `src/app/api/docs/route.ts` | comment corrected — it claimed `postinstall` vendored the assets, which was never true |
| `scripts/copy-swagger-ui.js` | header points at the guard that now reports a missed re-vendor |

## Decisions

- **No vendored manifest of versions or hashes.** The obvious
  alternative was writing a `vendor-manifest.json` beside the assets so
  the check needs no `node_modules`. Rejected: that is derived data
  stored beside its own source, the failure mode this repo has already
  been bitten by — two branches writing the same new value merge
  cleanly, both are green, and main is wrong with no suspicious diff.
  Comparing against the installed package has no such state to fall out
  of date.

- **Missing `node_modules/swagger-ui-dist` fails rather than skips.**
  A skipped comparison and a passing one are the same line in a CI log,
  and this drift survived two months precisely because "nothing reported
  a problem" was read as "there is no problem". Jest itself runs from
  `node_modules`, so a devDependency being absent when this guard
  executes means the tree is broken, not that the check is inapplicable.

- **The vendor script is still not wired into `postinstall`.** Issue
  #2125 offered that as the durable fix, and it is — but `postinstall`
  is pinned to exactly `patch-package`, and a `prebuild` hook would fix
  the *image* while leaving the committed tree lying, which is the state
  this guard exists to forbid. Manual re-vendor plus a check that fails
  loudly keeps one source of truth for what ships.

- **Verbatim copy, checked for CSP consequences first.** `patches/` has
  no `swagger-ui-dist` entry, so there is nothing repo-specific to
  re-apply. 5.32.14 introduces no new external origin (no jsdelivr, no
  unpkg, no web-font host); the CSS grew from 4 to 20 `url(data:…)`
  icons, covered by the existing `img-src 'self' data: https:`. The
  inline-script/style situation in the route is unchanged.
