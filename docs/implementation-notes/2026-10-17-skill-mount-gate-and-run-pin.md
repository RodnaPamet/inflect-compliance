# 2026-10-17 — skill mount gate and the per-run skill pin (1b)

**Commit:** step 1b of the agentic IAM roadmap (#3666)

## Design

```
startWorkflowRun
  └─ chosenDriver === 'flue'
       └─ resolveSkillPins(def.skills)             unknown / refused / unevaluated → 400, no row
            └─ resolveSkillsFor → mountable()      text scan (1c) + checkSkillMountable (1b)
  └─ createSealedRun(..., mountedSkills)           [] for static, pins for Flue, in the CREATE

executeFlueRun (every segment)
  └─ resolveSkillsFor(def.skills)
  └─ skillPinDrift(row.mountedSkills, pins)        mismatch → failRun('skill_pin_drift'), before dispatch

checkSkillMountable(skill)
  set?           → NOT_EVALUATED
  set for text?  → MALFORMED / NAME / VERSION / HASH_MISMATCH
  record?        → NO_RECORD
  record.set == committed set (canonical JSON)? → SET_MISMATCH
  recomputed rates ≥ thresholds?                → UNANSWERED / UNKNOWN / DUPLICATE / BELOW_THRESHOLD
```

`npm run skills:evaluate` is the only producer of `evaluation-record.json`: it
asks the configured runtime model each case, records the reported revision, and
writes only a record that passes.

## Files

| File | Role |
|---|---|
| `src/lib/agentic/flue/skills/mount-gate.ts` | The gate, the pin type, `parseMountedSkillPins`. |
| `src/lib/agentic/flue/skills/resolve.ts` | Gate applied per skill, cached; `resolveSkillPins`, `assertWorkflowSkillsMountable`, `skillPinDrift`. |
| `src/app-layer/usecases/workflow-runs.ts` | Pins at admission, before the row; named 400 on refusal; pin in the audit entry. |
| `src/lib/agentic/flue/execute.ts` | Fails a resumed run whose skills no longer match its pin. |
| `prisma/schema/agentic.prisma`, migration `20261017220000_workflow_run_mounted_skills` | The column, the array CHECK, the write-once trigger. |
| `scripts/skills-evaluate.ts` | The recorder. |
| `.github/workflows/skills-evaluate.yml` | Runs the recorder with the repository secret; uploads records as an artifact. |
| `src/app/t/[tenantSlug]/(app)/agents/runs/[runId]/` | The run detail page shows the pin. |
| `src/lib/agentic/flue/skills/*/evaluation-set.json` | A set for each of the six original skills, beside the two drafted with the standard. |
| `src/lib/agentic/flue/skills/evaluation-record.ts` | Optional, unscored `rationale` on a case. |

## Decisions

- **Write-once includes NULL → value.** The policy-card pin allows a late fill;
  this one does not, because skills are resolved before the row exists and a
  later write could only be a reconstruction.
- **`[]` and NULL are different facts.** Static runs record `[]`; old rows stay
  NULL and the page says "not recorded", never "mounted nothing".
- **SET_MISMATCH.** A record embeds its set, and `checkEvaluationRecord` checks
  that copy against the text — which would pass a record made before a hard case
  was added. The committed set and the record's set must match exactly.
- **The record's model is not tied to the run's model.** Model choice is per
  tenant by residency; requiring a record per model would refuse every skill to
  any tenant on an unrecorded model. Recorded as a known limit in the standard.
- **Drift fails the run instead of re-pinning.** A deploy that changes a skill
  mid-run would otherwise teach a run something its own row does not describe.
  A NULL pin (a run admitted before this deploy) is not compared, so the
  migration does not fail every run in flight.
- **The corpus unit test mocks the gate.** Its resolution tests are about
  mechanics; the gate and the corpus under the real gate are tested separately,
  so a mocked gate can never hide a skill that fails the real one.
- **Records come from a manual CI workflow, as an artifact.** The credential is
  a repository secret, so no session holds it. The workflow does not commit:
  a push made with `GITHUB_TOKEN` triggers no CI, and a branch without its
  required checks cannot merge. The run URL is the record's provenance.
- **Every shipped skill carries a set, and every case says why it proves
  anything.** The six sets were authored against each skill's own sentences,
  reviewed adversarially for cases a wrong answer could pass, and revised. Each
  case's `rationale` names the line it tests and why its expectation tells a
  right answer from the likely wrong one; without it, a reviewer cannot judge
  whether a `mustNotInclude` catches the failure or only a phrasing of it. The
  field is never scored. `tests/unit/agentic/skill-standard.test.ts` holds the
  whole corpus to both rules rather than a list of names.
- **No skill mounts yet.** Sets are committed here; records are not, because
  only the CI workflow may produce one. Until the first records land, every
  skill is `NO_RECORD` and no workflow declares one, so the gate refuses
  nothing in use.
- **The audit entry carries a digest of the pin, not the pin.** The run's
  `WORKFLOW_RUN_STARTED` row records `mountedSkillCount` and a SHA-256 over the
  canonical JSON of `mountedSkills`, so the hash-chained trail binds the
  write-once column, and the payload stays a shape `no-raw-prompt-logging` can
  read.
