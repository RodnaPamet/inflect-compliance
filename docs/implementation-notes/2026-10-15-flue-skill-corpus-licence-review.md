# The Flue skill corpus: licence review, and the mount it is reviewed against (#3470)

The last acceptance items of Flue 06. The corpus, the loader, the resolver and
the read-only Skills tab were already built; what was missing was the
behavioural proof that an agent loads **exactly** what its workflow declares,
a rendered test for the tab, and this note.

## The licence review

Six skills ship. Every one declares `license: proprietary` and a `sourceRef`,
measured from the frontmatter rather than asserted from memory:

| skill | sourceRef |
|---|---|
| `dora-register-duties` | original guidance; cites Regulation (EU) 2022/2554 Arts 28–30 **by article** |
| `eu-ai-act-classification` | original guidance; cites Regulation (EU) 2024/1689 **by article and annex number** |
| `evidence-sufficiency` | original guidance |
| `iso-27001-annex-a-drafting` | original drafting guidance; cites ISO/IEC 27001:2022 Annex A **by control identifier only** |
| `nis2-article-23-timelines` | original guidance; cites Directive (EU) 2022/2555 Art 23 **by article and paragraph** |
| `soa-authoring` | original guidance; cites control identifiers only, no standard text |

So the corpus is this product's own prose throughout. Nothing in it is a
third-party document redistributed under someone else's terms, which is why
`proprietary` is the honest value rather than a placeholder: there is no
upstream licence to inherit, and the files are ours.

`flue-skills-corpus` refuses a corpus where any skill declares no licence at
all — an unlicensed skill cannot be audited, and the loader is the only place
that can know.

## Why only the ISO claim is tested, and that is deliberate

Four of the six cite an external instrument, and only one of those citations
is backed by a test: `no skill reproduces ISO Annex A control titles (#3478)`
spot-checks five real Annex A titles against every skill's instructions, so a
later commit pasting them in for convenience fails CI.

The EU instruments get no equivalent check, and the asymmetry is the point
rather than an oversight:

- **ISO/IEC 27001:2022 is a copyrighted standard that is sold.** Reproducing
  Annex A's control titles or text redistributes something a customer is
  expected to buy. That is the one case where a convenience paste is a licence
  problem, so it is the one with a guard.
- **The EU instruments are published in the Official Journal.** Citing
  Regulation (EU) 2022/2554 by article, or quoting a deadline from Directive
  (EU) 2022/2555 Art 23, is not redistribution of a commercial work.

Written down here because an untested claim beside a tested one reads as a gap
somebody should close. The reason it is not a gap is the licence, not the
confidence.

The corpus also never *states* the requirement back at the reader, which is a
drafting rule rather than a licence one and is recorded in the skills
themselves: "a drafted implementation that paraphrases the standard back at the
reader states the requirement, not the answer to it."

## The mount is now proved behaviourally, and that found two things

`tests/flue/agent-mounts-only-declared-skills.test.ts` captures the `Context`
the model provider is handed — through a faux response factory — and asserts
what the model was actually told.

The existing unit tests covered the **resolver**: declaring nothing resolves to
nothing, an unknown name fails closed, the per-turn budget is enforced. All
true, and none of it proves the mount. A resolver that answers correctly into
an agent that *also* loaded the corpus by default would pass every one of those
cases, and "implicit global loading" — a run getting expertise its definition
never asked for — is invisible from the resolver's side.

### Skills are lazy, and the first draft of that test did not know it

Measured, by the test failing. Mounting a skill puts its **name and
description** into the system prompt under `## Available Skills`; the
instructions stay unloaded until the model calls the runtime's
`activate_skill` tool. The runtime says so in the prompt it writes: *"Skill
instructions and supporting resources stay lazy until activation or explicit
file reads."*

That confirms `catalogBytes` was built on the right model — it charges
`name: description` per skill per turn and nothing for the body — and the
contract is now pinned rather than assumed: a case asserts the instructions
are **absent** from the per-turn prompt, and that `activate_skill` is present,
so the absence reads as a deferral rather than a loss. If a runtime upgrade
started inlining instructions, the always-present cost of six skills would
jump by their full length with the budget check still green.

### A run's tool list is not the list this product computes

Also measured, and filed separately as #3569 rather than fixed here. A binding
carrying `tools: []` still reaches the model with `['task']`, and
`['activate_skill', 'task']` once a skill is mounted.

Neither widens reach today — `activate_skill` reaches only the corpus this run
declared, and `task` has no valid `agent` value with no subagent declared — but
it makes "the effective tool set for a run" two different lists: the
intersected one this product reports, and the longer one the model sees. It
matters for #3473, whose invariant assumes the parent's set *is* the
intersection.

## The Skills tab, and the claim it refuses

`tests/rendered/agent-skills-tab.test.tsx` covers the panel. The load-bearing
assertions are not that it renders:

- **It reads `/admin/agents/skills`,** not an agent-scoped route. An agent does
  not declare skills; a workflow definition does. A per-agent route would
  promise a binding that does not exist, and on a compliance surface an
  invented binding is worse than a broader true statement.
- **The scope notice is asserted,** because a reader on an agent's page
  reasonably assumes a list there describes that agent, and that sentence is
  the only thing between them and the assumption.
- **"No workflow declares it" is asserted,** in both directions. A
  shipped-and-unused skill costs nothing per turn and means the corpus and the
  workflows have drifted — worth seeing, not hiding.
- **Read-only is counted, not described.** The panel offers zero buttons,
  inputs, selects or `role="button"` elements over a populated list. A skill is
  a reviewed Markdown document; changing one is a pull request. "There is no
  edit button" is exactly the claim a later commit falsifies quietly.

## Verification

- `typecheck` EXIT=0, `lint` EXIT=0
- `--selectProjects flue`: 12 assertions, real Flue runtime and a faux provider
- `tests/rendered/agent-skills-tab.test.tsx`: 12 assertions
- Mutation-proved: dropping the skill mount reddens 5; mounting only the first
  declared skill reddens 1; inlining the instructions into the description
  reddens 1; removing the scope notice, adding an edit button, and blanking the
  "no workflow declares it" badge each redden 1.

One of those mutations is worth recording as a method note: the instruction-
inlining mutation first appeared to **survive**, and the cause was the mutation
rather than the test — the replace did not match (wrong indentation), changed
nothing, and reported success. Re-run with the match count asserted, it reddens.
A mutation proof needs its own positive control.
