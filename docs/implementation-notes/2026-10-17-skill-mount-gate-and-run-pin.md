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
| `prisma/schema/agentic.prisma`, migration `20261017200000_workflow_run_mounted_skills` | The column, the array CHECK, the write-once trigger. |
| `scripts/skills-evaluate.ts` | The recorder. |
| `src/app/t/[tenantSlug]/(app)/agents/runs/[runId]/` | The run detail page shows the pin. |

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
