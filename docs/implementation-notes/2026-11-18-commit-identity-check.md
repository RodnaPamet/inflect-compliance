# 2026-11-18 — Commit identity check

## Design

GitHub credits a commit to whichever account registered its email: the
author's, the committer's and every `Co-authored-by:` trailer's. Two commits
on `main` (`b0a20c27b`, `c74cebbd1`, both 2026-10-08) carry
`Co-authored-by: h0mele55 <x@y>`. `x@y` is registered to an unrelated
account, so GitHub lists that account as a contributor to the repository.

Squash-merge is how such an address gets in. It turns the author of every
commit in a pull request into a trailer on the squash, so a placeholder
`user.email` on whatever machine pushed to the branch reaches `main` without
anybody typing it. A full scan of `main` finds three such addresses:
`x@y` (2), `user@users-Mac-mini.local` (17) and `user@192.168.1.13` (1).

```
pull_request ─▶ Commit Identities ─▶ git log base..head
merge_group  ─▶   (same job)      ─▶ git log merge_group.base_sha..head_sha
                                       │  author · committer · Co-authored-by
                                       ▼
                         classifyEmail()  (scripts/lib/commit-identities.js)
                                       │
                         ::error annotation + job summary, exit 1
```

Rewriting `main` is not an option, so the existing commits stay as they are.
The check stops the next pull request that would add one.

## Files

| File | Role |
| --- | --- |
| `scripts/lib/commit-identities.js` | The rule: `classifyEmail`, trailer parsing, range problems (pure, CommonJS so Jest requires it directly) |
| `scripts/check-commit-identities.mjs` | CLI: reads `git log <base>..<head>`, annotates, writes the job summary, exits 0/1/2 |
| `.github/workflows/commit-identities.yml` | Runs it on `pull_request` and `merge_group` |
| `tests/unit/commit-identities.test.ts` | The rule's cases, and the CLI run over a real temporary repository |

## Decisions

- **Structure, not an allowlist.** An address passes when its domain is a
  public, multi-label DNS name. It fails on a single-label domain, an IP, a
  special-use or private TLD (`.local`, `.lan`, `.internal`, `.test`, …) or a
  documentation domain. GitHub noreply, Anthropic and the release bot all pass
  on structure, so a new bot needs no entry, and there is no list where an
  exception for `x@y` could be added later.
- **A real domain with an invented mailbox passes** (`user@inflect.dev`).
  Nothing offline can tell whether a mailbox exists. Repeating the harm on a
  real domain also needs control of that domain's mail, which is a different
  threat.
- **Only the range is checked.** History before `base` is not the pull
  request's to fix; the test proves a bad base commit does not fail the range.
- **It answers in the queue.** Under `merge_group` it checks the candidate's
  commits, which include the squash commit's generated trailers: the exact
  text that lands on `main`. So it can be made a required check without
  hanging the queue. Being required is a ruleset setting, which this PR cannot
  make. Until the owner adds `Commit identities` to the required set, a
  failure is visible but does not block.
- **A separate workflow, not a `ci.yml` job.** It needs no install and no
  token, and keeping it out of `ci.yml` keeps it out of the coverage
  partition, which counts Jest jobs. Its unit test runs in the ordinary `Test`
  shards.
- **An unreadable range exits 2, never 0.** A check that cannot see the
  commits must not report them clean.
