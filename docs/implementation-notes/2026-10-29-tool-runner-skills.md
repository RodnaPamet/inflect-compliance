# 2026-10-29 — Skills on the Tool Runner engine (Claude agents 2d)

**Commit:** `feat(agents): skills on the Tool Runner engine — activate_skill serves the run's pinned skills (Claude agents 2d)`

## Design

```
admission (startWorkflowRun)                 each segment (tool-runner/execute.ts)
  resolveRunSkillMount(ctx, def)               resolveRunSkillMount(ctx, def)
    profile? skillRefs: repository names         └─ refusal → failRun skill_not_mountable
             + tenant versions BY NAME           skillPinDrift(row pins, mount pins)
    else:    def.skills + tenant on workflow      └─ drift → failRun skill_pin_drift
    └─ resolveRunSkills → gate, scan, budget     system: preamble · <skill_catalogue> · operator block
  pins written on the row                        tools:  resolved set … + activate_skill
                                                    activate_skill(name)
                                                      mounted and hash == row pin → <skill …>text</skill>
                                                      otherwise → is_error, reason named
                                                      TOOL_CALL step, charged to STEPS
```

Nothing new decides what a run may mount. The resolver, the mount gate, the
text scan and the per-run catalogue budget are the ones Flue already used; this
step makes a profile's skills reach them and puts the result in front of the
Tool Runner's model.

## Files

| File | Role |
| --- | --- |
| `src/lib/agentic/flue/skills/tenant-mount.ts` | A profile's run mounts its skill refs; tenant ones read by name in the run's tenant |
| `src/lib/agentic/tool-runner/skills.ts` | The catalogue text and `activate_skill` |
| `src/lib/agentic/tool-runner/supplied-tools.ts` | The engine's own tools, as data, for the register |
| `src/lib/agentic/tool-runner/execute.ts` | Mount, drift check, catalogue and tool per segment |
| `src/lib/agentic/tool-runner/params.ts` | The catalogue's place in the system prompt |
| `src/lib/agentic/tool-runner/tools.ts` | One queue shared with the engine's own tool |
| `src/lib/agentic/tool-runner/driver.ts` | The interim `SKILLS_NOT_SERVED` refusal removed |
| `src/lib/agentic/flue/execute.ts` | A mount refusal settles the run instead of escaping |
| `src/app-layer/usecases/agent-tool-exposure.ts` | `engineSuppliedTools()`: both engines' tools, one row per name |
| `tests/helpers/driver-conformance.ts`, `driver-conformance-skills.ts` | The `refused-skill-never-reaches-the-model` scenario and the mount stand-in |

## Decisions

- **A profile's tenant skills are read by name, not by workflow.** A profile
  names a tenant skill directly, so the read that serves a registered workflow
  (versions whose `workflowKeys` name it) would find nothing for a profile key.
  One approved version per skill is a partial unique index, so the name read
  returns at most one row per name. A name with no approved version refuses the
  run rather than teaching it less than its version names.
- **The tool re-hashes what it returns.** The segment already checked the pins,
  but the string handed to the model is what must match. The check costs one
  hash per activation.
- **A refusal never echoes the model's string.** The error names the reason;
  the ledger keeps the reason and, for a mounted skill, its pin. A name the
  model invented is not stored or sent back.
- **An activation is a step, not a tool call.** It writes a TOOL_CALL row, so
  the ledger shows which skill the model read, and it is charged to `STEPS`. It
  is not charged to `TOOL_CALLS`, which is the policy card's allowance for
  calls that reach tenant data.
- **The tool sits outside the empty-catalogue check.** A run with skills but no
  reachable tool can do nothing with an answer, so it still settles
  `EMPTY_CATALOGUE` and sends nothing.
- **Flue settles a mount refusal too.** It used to throw out of the segment. The
  conformance scenario asks both engines for the same named outcome, so Flue
  now fails the run with the same `skill_not_mountable` reason.
- **The Tools tab gets one row per tool name.** `activate_skill` is supplied by
  both engines under the same condition, so the exposure report merges by name
  and lists the engines, and the row carries each engine's bound sentence.
