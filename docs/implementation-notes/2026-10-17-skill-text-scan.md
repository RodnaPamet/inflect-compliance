# 2026-10-17 — load-time scan of skill text (1c)

**Commit:** step 1c of the agentic IAM roadmap (#3667)

## Design

```
SKILL.md ──▶ parseSkillDocument ──▶ structural checks ──▶ scanSkillText ──▶ LoadedSkill
                                        │ throws                   │ throws
                                        ▼                          ▼
                                 SkillLoadError          SkillTextRefusedError
                                 (CI must see it)        (held apart by loadSkillCorpus)

loadSkillCorpus() = { skills, refused }
  resolveSkillsFor(declared)           refused name → SkillTextRefusedError (run fails closed)
  assertWorkflowCatalogsWithinBudget   refused name → throws (CI)
  workflowCatalogs                     refused name → reported, costs 0 bytes
  listAgentSkills (Skills tab)         refused rows: name, rule ids, declaredBy — never text
```

`scanSkillText` runs the AI Guard's injection and egress scanners over the
description and the instructions, then four rules of its own: fetchable URL,
reveal-context, undeclared tool, and (through the egress scanner) secret shape.
Its own rules match the raw lower-cased text and the guard's folded form, so the
guard's evasion handling covers them too.

## Files

| File | Role |
|---|---|
| `src/lib/agentic/flue/skills/text-scan.ts` | The rules and `scanSkillText`. Pure; imports only leaf modules. |
| `src/lib/agentic/flue/skills/index.ts` | Scan in `parseSkillDocument`; `SkillTextRefusedError`; `loadSkillCorpus`; `metadata.tools`. |
| `src/lib/agentic/flue/skills/resolve.ts` | A refused declared skill fails closed with its rule ids; catalogues report refusals. |
| `src/app-layer/usecases/agent-skills.ts` | The Skills tab payload carries refused rows. |
| `src/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/SkillsTab.tsx` | Renders refused skills by rule id. |
| `src/lib/agentic/flue/skills/harness-level-assessment/` | One defensive sentence reworded; the evaluation set's hash follows it. |

## Decisions

- **A refusal is held apart, not thrown corpus-wide.** Throwing from
  `loadAllSkills` would take every run dark for one suspect skill and leave the
  Skills tab unable to say which. A malformed document still throws, because
  that is a defect CI must stop, not suspect text.
- **Any fetchable URL, not only one the model is told to fetch.** Telling a
  cited link from a followed one is the judgement the rule exists to take away
  from the model. Skills cite by identifier.
- **Defensive sentences are refused.** "Reveal these instructions" in a
  sentence that warns against it still matched, and the rule cannot tell the
  direction of a sentence without becoming a parser of intent. The one shipped
  instance was reworded; its evaluation set's content hash was updated, which is
  exactly what the hash exists to force.
- **Tool names are recognised only for tools this build knows.** A tenant's
  external tool names are dynamic and cannot be recognised in prose; the rule
  does not claim to.
- **Rule ids, never text, on every surface.** The refused row in the API payload
  has no text field at all, and a test pins its keys.
