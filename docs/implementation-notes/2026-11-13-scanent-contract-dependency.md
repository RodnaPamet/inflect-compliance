# 2026-11-13 — The harness contract comes from `@rodnapamet/scanent-contract`

**Commit:** `refactor(agentic): take the harness contract from @rodnapamet/scanent-contract`

Step 1 of 3 on the application side of scanent issue #26. Step 2 moves the
harness tab's table to the package's `harness-matrix-model`; step 3 deletes
`packages/agent-harness-scanner`.

## Design

scanent (the standalone Agent Estate Scanner, `RodnaPamet/scanent`) was carved
out of this repository and now carries everything the application's copy of
the report contract had, plus more. Owner decision: the application depends
on the package instead of keeping a copy, installed from the GitHub release
file, so no registry token is involved:

```
package.json
  "@rodnapamet/scanent-contract":
    "https://github.com/RodnaPamet/scanent/releases/download/v0.15.0/rodnapamet-scanent-contract-0.15.0.tgz"
```

The lockfile records that URL as `resolved` with the tarball's `sha512`
integrity, so `npm ci` refuses any other bytes. The package is CommonJS with
`./*` subpath exports and one dependency, `zod` at exactly 4.6.7, which is the
version this repository's lockfile already resolves: `npm ls zod` shows one
copy, deduped, so a schema of the package is a schema of the application.

The eight modules the contract occupied keep their paths and become one-line
re-exports (`export * from '@rodnapamet/scanent-contract/<module>'`), so the
~100 importers are untouched:

| Application path | Package module |
|---|---|
| `src/lib/agentic/harness-contract.ts` | `harness-contract` |
| `src/lib/agentic/harness-contract-rules.ts` | `harness-contract-rules` |
| `src/lib/agentic/harness-findings.ts` | `harness-findings` |
| `src/lib/agentic/harness-ladder.ts` | `harness-ladder` |
| `src/lib/canonical-json.ts` | `canonical-json` |
| `src/lib/security/cidr.ts` | `cidr` |
| `src/lib/mcp/receipt-verification.ts` | `receipt-verification` |
| `src/lib/audit-redact.ts` | `audit-redact` |

None of the eight held code the package lacks, so nothing stayed local.
`harness-matrix-model` (and the `integrations-*` modules) are importable as
`@rodnapamet/scanent-contract/<module>` and are not used yet.

The reference scanner (`packages/agent-harness-scanner`) imports the package
directly. It had to change either way: its image copied the eight files by
path and ran them under tsx, and a re-export would have needed the package in
the image regardless. So the image installs the package from the same release
URL (its own manifest and lockfile), copies no application module, and its
`tsconfig` declares no `@/` alias.

## Files

| File | Role |
|---|---|
| `package.json`, `package-lock.json` | The release-URL dependency with its integrity |
| the eight files above | Re-exports |
| `packages/agent-harness-scanner/src/**`, `container/smoke-verify.ts` | Import the package instead of `@/` |
| `packages/agent-harness-scanner/Dockerfile`, `Dockerfile.dockerignore` | No application module copied |
| `packages/agent-harness-scanner/container/{package.json,package-lock.json,tsconfig.json}` | The package installed; no `@/` alias |
| `eslint.config.mjs` | Scanner: every `@/` import refused. Funnel: the package's ladder and table model refused by name |
| `tests/helpers/client-import-graph.ts` | Walks into the package's compiled modules |
| `tests/guards/client-reachable-modules-import-no-node-builtins.test.ts` | Proves the walk reaches the package and sees its `crypto` |
| `tests/guardrails/harness-scanner-contract-import-closure.test.ts` | Each of the eight is a bare re-export; the scanner imports no repository file outside itself |
| `tests/unit/agent-harness-scanner/scanner-image.test.ts` | No application module in the closure; the release URL is an exact pin |
| `tests/guards/agent-action-receipt.test.ts` | Reads the Apache-2.0 boundary from the package's verifier |
| `CLAUDE.md`, `docs/agent-harness-contract.md`, scanner README | Say where the contract lives |

## Decisions

- **Behavioural differences between the application's copy and the package**,
  as `scripts/compare-inflect-copy.js` and scanent's `docs/EXTRACTION.md` list
  them, all adopted:
  - `HarnessRefusal` is derived from the exported `HARNESS_REFUSALS` array
    instead of a union literal: the same eight codes in the same order, so
    every consumer type-checks unchanged.
  - `firstSecretShapedMember` takes `unknown` instead of a report body: a
    widening, so every existing call compiles and behaves the same.
  - `cidr`'s IPv6 parse returns `null` for an address with more than eight
    groups around `::`, where the copy threw on `Array(negative)`. Every caller
    already handles `null` as "not an address"; a throw there was a crash on
    hostile input.
  - New exports, unused here so far: `LADDER_VERSION` / `ladderVersionOf` (a
    hash of the ladder's levels, criteria and bars, computed at load in the
    server-only `harness-contract`), `HARNESS_REFUSALS`, `verifySignedEnvelope`
    and `describeReportSchemaIssue` (the first seven checks and the issue text
    split out of `verifyAndParseHarnessReport`, a refactor with the same
    order and results).
  - The package declares `StoredSource` and `HarnessAgentModels` itself; the
    application's read model uses them through the re-export, as before.
- **The client import-graph guards walk into the package.** They used to stop
  at any bare specifier. Stopping at this one would have weakened them: the
  modules clients reach (`harness-ladder`, `harness-contract-rules`,
  `harness-findings`) now live there, and `harness-contract`,
  `receipt-verification` and `audit-redact` there require `crypto`. The
  walk resolves a subpath with `require.resolve` (the package's `exports`
  map, upward from the test, so a worktree without its own install works)
  and follows the compiled `require()`s.
- **The two cross-checks scanent left behind stay here and now read the
  package**: the locale label per incomplete reason and the migration CHECK
  per source kind import `INCOMPLETE_REASONS` and `SOURCE_KINDS` through the
  re-export.
- **Dependabot does not update a URL dependency, and that is wanted.** A new
  contract version is a pull request that changes the URL (and the lockfile's
  `resolved` and `integrity`) in both `package.json` and the scanner image's
  `container/package.json`, so the contract tests run on exactly that change.
  scanent's release notes say when a contract id, a limit or the ladder moves.
- **Moving to a new release by hand**: replace the version in both URLs, then
  `npm install` in the root and in `packages/agent-harness-scanner/container`;
  check `npm ls zod` still shows one copy (the package pins `zod` exactly);
  and move the version in `license:check`'s `--excludePackages` entry
  (`@rodnapamet/scanent-contract@<version>`). The package is BUSL-1.1, which
  that check refuses in a dependency; the entry excludes this first-party
  package (the licensor is the same, Inflect Ltd.) by name AND version, the
  pattern `docs/shared-ui-package-design.md` §5.9 set for `@inflect/ui`, so a
  bumped version stops matching and the check fails until somebody moves the
  pin on purpose.
