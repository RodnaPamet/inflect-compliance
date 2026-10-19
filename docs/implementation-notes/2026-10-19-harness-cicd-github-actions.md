# 2026-10-19 — The harness scanner reads GitHub Actions (#3784)

**Commit:** see the pull request for #3784.

## Design

```
config  { kind: 'cicd', product: 'github-actions', repositories: [owner/repo…], tokenEnv }
          │  token: Contents: read + Secrets: read, from the environment
          ▼
per repository, GET on api.github.com only
  /repos/{owner}/{repo}                                 readable at all? (404 = UNREACHABLE)
  /repos/{owner}/{repo}/contents/.github/workflows      the files (404 here = none)
  /repos/{owner}/{repo}/contents/.github/workflows/{f}  each .yml/.yaml, base64
  /repos/{owner}/{repo}/actions/secrets                 names + updated_at, paged, count checked
          │
          ▼
analyseWorkflow(text)  js-yaml core schema, maxAliases 1000, maxDepth 100
  secrets   ← expressions only: ${{ … }} spans and whole if: values
  dynamic   ← computed index, toJSON(secrets), secrets: inherit to another repo
  jobs[]    ← effective token scope: job's, else workflow's, else repository default
          │
          ▼
workflowObservation   principal iff secret ∨ dynamic ∨ some job may write
  credentials  github-token:// (+ github-oidc://) + github-secret:// per reference
  verdicts     H2.credential_bound, H2.grant_kind_declared, H2.tools_allowlisted
unboundCredentials    repository secrets no file references, only when every file
                      parsed and none is dynamic
```

## Files

| File | Role |
| --- | --- |
| `packages/agent-harness-scanner/src/sources/github-actions.ts` | The source, the pure workflow analysis and the observation builder |
| `packages/agent-harness-scanner/src/http.ts` | `getJson`'s `absentOk`: a 404 that is an absence, asked for by name |
| `packages/agent-harness-scanner/src/scanner-surface.ts` | The four reads declared as templates, template matching in `isDeclaredRequest`, version 0.8.0 |
| `packages/agent-harness-scanner/src/config.ts`, `scan.ts`, `index.ts` | The `cicd` configuration entry, its construction, the exports |
| `packages/agent-harness-scanner/container/package.json`, `package-lock.json` | `js-yaml` 5.4.2, the image's fourth pinned package |
| `tests/unit/agent-harness-scanner/github-actions-source.test.ts` | The source over a fixture repository, by request log, and end to end through a signed report |

## Decisions

- **A workflow is the principal, not a secret or the App.** A secret is a
  credential, and the contract carries credentials on agents. The release
  GitHub App is seen through the private key that mints its token, because the
  App installation is not something a Contents/Secrets token can read.
- **A read-only workflow holding nothing is a row.** Reporting every workflow
  would raise `SHADOW_AGENT` on a lint job. What makes a workflow an agent here
  is a credential worth stealing or a token that can change something.
- **A missing `permissions:` may write.** The repository default needs
  Administration: read to see, and the token does not take it. The source does
  not assume the safe answer it cannot read, so such a workflow is reported, and
  its `H2.tools_allowlisted` names the job.
- **Expressions only.** Counting a `secrets.X` that appears in a script's prose
  would credit a workflow with a credential it does not hold, and would hide an
  orphan. String literals are stripped before the scan for the same reason.
- **Unbound is withheld, not guessed.** A repository secret is unbound only when
  every file in the directory was read and parsed and none reaches secrets in a
  way that cannot be read. Otherwise the repository reports no unbound secret
  at all, rather than a list that might name one in use.
- **`absentOk` is opt-in per request.** Every other source still reads a 404 as
  `UNREACHABLE`. This source asks for an absence only after the repository
  itself answered, so a token that cannot see a repository never reads as a
  repository with no workflows.
- **`js-yaml`, not a hand-written YAML subset.** It is already a reviewed
  dependency of the repository. A subset parser over indentation would be the
  scanner's newest untested parser, and a mis-read permissions block decides
  `H2.tools_allowlisted`. The two amplification paths the library documents are
  capped at the call. The exposure is recorded in
  `docs/dependency-risk-review.md`.
- **Not read: organisation and environment secrets, CODEOWNERS, GitHub
  Enterprise Server.** Each is named in the README, the DPIA and the onboarding
  guide, so the absence is not mistaken for coverage.
