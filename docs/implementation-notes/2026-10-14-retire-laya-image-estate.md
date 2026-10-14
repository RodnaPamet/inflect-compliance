# 2026-10-14 — retiring the Laya image estate (part 1 of 2)

**Commit:** `<sha> chore(ci): retire the Laya image estate`

## Design

The owner withdrew the AI part of the legacy-access recertification path on
2026-10-14, in two steps. First TypeSafe AI was withdrawn as a proposed
sub-processor and the `laya` service was removed from the production Compose
file and stopped on the VM (#3519 and the compose change). Then, asked how far
the removal should go, the owner chose to **retire the whole Laya estate** rather
than keep a dormant build pipeline.

This note covers the first half: the **image and CI estate**. The second half —
the provider module, the `LAYA_*` environment declarations, the evaluation
script and the design-document amendments — is a separate change, because its
test surface is the identity-match module rather than the workflow set and the
two review as different things.

What was removed:

```
deploy/laya/Dockerfile                    the image — 2,438 MB of CUDA wheels on a CPU server (#3417)
deploy/laya/README.md
.github/workflows/laya-image.yml          dispatch-only build / scan / push by digest
.github/workflows/ci.yml                  the `laya-image` job (164 lines), the `laya` changes
                                          output, its paths filter, and the `!deploy/laya/**`
                                          exclusion on the `container` filter
```

The container had already stopped: host memory went 4789 MB → 3033 MB and
`readyz` answered 200 in 0.17 s with the OrangeHRM lab intact. What remained was
a pipeline that still built a 10.6 GB image whenever somebody touched
`deploy/laya/**`, which is what #3417 was about.

## Files

| File | Role |
| --- | --- |
| `.github/workflows/ci.yml` | job, filter, output and exclusion removed; 2945 → 2781 lines |
| `.github/workflows/laya-image.yml` | deleted |
| `deploy/laya/{Dockerfile,README.md}` | deleted |
| `tests/guardrails/ci-checks-unreachable-before-merge.json` | two registry entries removed (18 → 16) |
| `tests/guardrails/contended-json-format.test.ts` | the registry's `keyOrderSha` moved |
| `tests/guardrails/trivy-no-rebuild.test.ts` | the filter-exclusion test removed; scanner-set member re-pointed |
| `tests/guardrails/publish-scans-before-push.test.ts` | the publish-site list is one entry |
| `tests/guardrails/merge-queue-trigger-coverage.test.ts` | the queue-exempt entry removed; the `changes`-outputs floor lowered |
| `tests/guardrails/dockerfile-offline-ordering.test.ts` | its subject is gone; the guard is kept, dormant, and says so |

## Decisions

- **Five guards had to be edited, and none of them was edited to make CI quiet.**
  Each had a live assertion about something that no longer exists, and in every
  case the choice was between deleting the assertion and re-pointing it at a real
  subject. Which one, and why, is recorded at the site rather than here, because
  the site is where the next reader will be standing.

- **The `dockerfile-offline-ordering` guard is kept even though its subject is
  deleted, and the population test now says plainly that no Dockerfile in the
  repo sets an offline flag.** The alternative was a quiet floor change from 2 to
  1, which is how a guard becomes a thing that passes rather than a thing that
  checks. It is kept rather than deleted because its detector is proved against
  synthetic Dockerfiles, so it can still express the failure it names — the
  difference between dormant and dead — and because the edit that causes the bug
  is the tempting one (group the `ENV`s together).

- **The `publish-scans-before-push` list is now a single member, which is worth
  noticing rather than shrugging at.** That assertion exists to catch a publish
  site that stops being *recognised* as one. It still does: a renamed step in
  `ghcr-publish.yml` empties the list and fails. What it can no longer do is tell
  "the other site was deleted" from "the other site stopped being recognised",
  so the deletion is written into the test.

- **The `changes`-outputs floor went from 2 to 1 and the generalisation stays.**
  That test was once hardcoded to the only output that existed, which is why a
  second output added later — `laya` itself — passed it unexamined. Removing
  `laya` returns the job to one output but does not make the old shape correct
  again: the subject is the rule, so the test ranges over whatever outputs exist.

- **The `!deploy/laya/**` exclusion is gone and the lesson it carried is kept as
  a comment.** A laya-only change once tripped `deploy/**`, ran `Docker Build`
  for 19 m 51 s, went green, and had opened the root Dockerfile rather than the
  one the pull request changed (#3418). The exclusion was the fix for the filter
  half; the `file:`-key assertion in `trivy-no-rebuild` is the half that survives
  a deletion, and that distinction is why only one of the two is gone.

- **Four prose references to `deploy/laya/Dockerfile` are deliberately left**, in
  `systemone-wire.ts`, `intent/laya-chooser.ts`, `legacy-adjudication-pass.test.ts`
  and the design document. Each cites the Dockerfile as the thing a measurement
  was taken against, which remains a true statement about the past. They are
  reworded in part 2, where the design document is amended as a whole.

- **The image itself is left on the VM's disk.** 10.6 GB against 31 % of 99 GB
  used; deleting it buys nothing today and a stopped container's image is not a
  running cost.
