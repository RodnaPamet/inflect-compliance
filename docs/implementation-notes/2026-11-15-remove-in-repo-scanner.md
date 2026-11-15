# 2026-11-15 — Remove the in-repo harness scanner; the VM runs scanent

**Commit:** `chore(agents): remove the in-repo harness scanner; the VM runs scanent`

## Design

Step 4 of scanent #26. The agent harness scanner is the standalone scanent
product (github.com/RodnaPamet/scanent). Two earlier steps already moved the
parts this repository depends on:

- the report contract, ladder and findings planner are the
  `@rodnapamet/scanent-contract` package, which the ingest re-exports
  (`2026-11-13-scanent-contract-dependency.md`);
- the production VM runs scanent's signed image, `ghcr.io/rodnapamet/scanent`,
  from `deploy/docker-compose.harness-scanner.yml` and the `Scanner VM` workflow
  (`2026-11-13-vm-scanner-runs-scanent.md`).

That left `packages/agent-harness-scanner/` as a copy nothing deployed: its own
tests, its own CI job, its own publish workflow, its own Dependabot entries and
lint blocks. This change deletes the copy and everything that existed only to
build, test or pin it. The ingest, the contract package, the estates, the VM
overlay and the `Scanner VM` workflow are unchanged.

```
before:  packages/agent-harness-scanner ──(runScan)──> ingest   (tests)
         ghcr.io/rodnapamet/scanent ──────────────────> ingest   (VM)
after:   agent-harness-fake-scanner.ts ─────────────────> ingest   (tests)
         ghcr.io/rodnapamet/scanent ──────────────────> ingest   (VM)
```

## Files

| File | Role |
| --- | --- |
| `packages/agent-harness-scanner/` | Deleted: source, container manifest and lockfile, Dockerfile, README |
| `tests/unit/agent-harness-scanner/`, `tests/fixtures/agent-pay-scanner/` | Deleted: the scanner's own suites and the Agent Pay fixture record only they read |
| `tests/helpers/agent-harness-{source-fakes,code-fixtures,provider-sdk-fixtures,estate-fixtures}.ts` | Deleted: used only by the scanner's tests |
| `tests/integration/agent-harness-{code-source,langsmith}.test.ts` | Deleted: they ran the real scanner against fakes |
| `tests/guardrails/scanner-never-reads-credential-values.test.ts` | Deleted: its invariant is about the scanner's code, which is scanent's |
| `tests/integration/agent-harness-estates.test.ts` | Scans are signed by `agent-harness-fake-scanner.ts`; the estate fixtures are inlined |
| `tests/integration/agent-harness-contract-v2.test.ts` | Gains section 5, the `code`-read close of `UNPINNED_WRITE_TOOL`, ported from the code-source suite |
| `tests/integration/agent-harness-ingest.test.ts` | Asserts the stored digest is the signed body's, ported from the LangSmith suite |
| `.github/workflows/scanner-image.yml`, `ci.yml` (`scanner-image` job) | Deleted |
| `.github/dependabot.yml`, `eslint.config.mjs`, `package.json`, `package-lock.json` | The package's entries removed |
| CI guards (`ci-check-requiredness-is-declared`, `merge-queue-trigger-coverage`, `security-gate-strictness`, `publish-scans-before-push`, `ci-checks-unreachable-before-merge.json`, `contended-json-format`, `codeql-suite-pinning`, `harness-scanner-contract-import-closure`, `no-secrets`) | The job's, workflow's or package's entry removed; each guard kept |
| CLAUDE.md and the docs that named the package | Point at scanent |

## Decisions

- **Two ingest assertions were ported, not dropped.** The deleted integration
  suites mostly tested the scanner (what it reads, what it leaves out). Two
  assertions were about the INGEST and had no fake-scanner equivalent: that an
  incomplete `code` read closes no `UNPINNED_WRITE_TOOL` while a complete one
  with no unpinned write tool closes it with no `mcp` source (#3754), and that
  the stored `reportDigest` is the digest of the signed body. Both now sign
  with the reference fake.
- **The estates suite keeps every estate assertion and loses two scanner
  ones.** "Every Okta token except the scanner's own" lost its second half,
  and "no credential reached a stored scan" was removed: both are properties of
  what a scanner puts in a report, which a fake that holds no credential cannot
  test. They are scanent's to test. The schedule check now asserts the stored
  cadence against the declared one, since there is no scanner configuration in
  the repository to compare it with.
- **The lockfile was edited by script, not by `npm install`.** Only the two
  entries for the workspace were removed; a lockfile-only install in the
  sandbox also dropped unrelated `libc` fields.
- **The DPIA's scanner-side evidence now points at scanent.** R15 and R16 named
  files in the deleted package. Their evidence is scanent's code and tests,
  and the DPIA says so rather than citing paths that no longer exist. This is a
  change to where a signed assessment's evidence lives, for the owner to know.
- **Clients run scanent's signed image.** The onboarding and managed-service
  docs said a client built the container from a checkout of this repository
  (owner decision 2026-10-19); with the Dockerfile gone they say to deploy the
  signed image, pinned by a verified digest, as Inflect's own estate does.
- **History is noted, not rewritten.** The roadmap, the Agent Pay plan and the
  dependency review keep their records of what was built here and say where it
  went.
