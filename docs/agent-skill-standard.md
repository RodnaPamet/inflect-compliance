# The agent skill standard

What a skill must be before an agent may be taught with it. A **skill** is a
Markdown document an agent loads at run time: a name and a description the model
reads on every turn, and instructions it reads when it decides the task matches.
It is instruction text the model trusts, so it is treated as part of the agent's
supply chain: written to a standard, reviewed, evaluated and pinned.

The corpus lives in `src/lib/agentic/flue/skills/`, one directory per skill. The
loader is `src/lib/agentic/flue/skills/index.ts`, the resolver that mounts skills
on a run is `resolve.ts` beside it, and the evaluation format is
`evaluation-record.ts`. A tenant may also author its own skills inside the
product, under the same rules; see [Tenant-authored skills](#tenant-authored-skills).

## The nine rules

| # | Rule | What it means | Enforced by |
|---|---|---|---|
| 1 | **A skill teaches; it never grants.** | Tools come from grants. A skill that names a tool confers nothing, and a delegated specialist's skills are intersected with what the parent workflow declared. | `src/lib/agentic/flue/subagents/index.ts` (narrowing); the tool funnel in `src/lib/mcp/authorize.ts` |
| 2 | **Declared, not ambient.** | A run mounts exactly the skills its workflow declares, plus its own tenant's approved skills whose approved version names that workflow. An unknown name fails closed. | `resolveSkillsFor` and `resolveRunSkills` in `resolve.ts`; `tests/flue/agent-mounts-only-declared-skills.test.ts` |
| 3 | **Bounded.** | At most 8 KiB of instructions per skill. The catalogue line (name and description) costs bytes on every turn, so each workflow's declared skills, and each run's mounted skills, fit in 2 KiB, counting repository and tenant skills together. The corpus as a whole is not capped. | `MAX_SKILL_BYTES`, `MAX_CATALOG_BYTES`, `assertWorkflowCatalogsWithinBudget` and `resolveRunSkills` |
| 4 | **Licensed and sourced.** | Every skill states a licence, a source and a version. Standards are cited by identifier; sold standard text, such as ISO Annex A control titles, is never reproduced. | The loader refuses a missing licence; `tests/unit/flue-skills-corpus.test.ts` spot-checks ISO titles |
| 5 | **Reviewed as code.** | A change to a repository skill is a pull request. The product shows repository skills read-only, and the directory of readable documents is the record of what agents can be taught. A tenant skill is reviewed in the product instead, by a person other than its author. | `tests/rendered/agent-skills-tab.test.tsx` and `tests/rendered/agent-skills-tenant-authoring.test.tsx` count zero controls on the repository section |
| 6 | **Output discipline.** | A procedure ends in a proposal or a named gap, cites the artefact it relied on, refuses when a required input is missing, and never treats an absence of exceptions as evidence. | `metadata.output` and `metadata.requiredInput`, validated by the loader; run admission refuses a missing required input (`src/lib/agentic/workflows/required-input.ts`) |
| 7 | **Evaluated before mounted.** | Each version ships an evaluation set, and a record of a real model's answers must pass the set's thresholds before a run may mount it. | `checkSkillMountable` in `mount-gate.ts`, applied by the resolver; records are made by `npm run skills:evaluate` |
| 8 | **Pinned on the run.** | A run records each mounted skill's name, version and content hash, so "what did the agent know" is answerable per run. A tenant skill's pin also carries `origin: 'tenant'` and its version's id. | `WorkflowRun.mountedSkills`, written at admission and refused any later change by a trigger; a resume whose skills no longer match the pin fails |
| 9 | **Injection-safe text.** | No URL the model is told to fetch, no instruction about revealing its context, no tool name outside the declared set, no secret-shaped string. | `scanSkillText` in `text-scan.ts`, run by the loader on every document; see below |

## Frontmatter

```yaml
---
name: access-review-preparation        # equals the directory name
description: What the skill does, and when to use it. Read on every turn.
license: proprietary                   # required
metadata:
  sourceRef: original guidance; cites ISO/IEC 27001:2022 A.5.18 by identifier only
  version: '1'
  requiredInput: campaignId, subjectRef  # optional: camelCase input names
  output: proposal                       # optional: proposal or report
  controls: A.5.18, CC6.3                # optional: control identifiers only
  evaluation: evaluation-set.json        # optional: a file in this directory
  tools: list_controls, propose_finding  # optional: tool names the skill expects
---
```

The five optional keys are validated when present and ignored when absent. A
malformed value is a load error that names the key. Declaring a tool in
`tools` grants nothing (rule 1); it is what the text scan checks tool names
against.

## The load-time text scan

Every skill document that passes the structural checks is scanned before it can
be mounted. The scan reads the description and the instructions, and reports
stable rule ids:

| Rule id | Refuses |
|---|---|
| `skill.injection` | Anything the AI Guard injection scanner flags, at any verdict. The guard's own rule ids are reported beside it. |
| `skill.fetchable_url` | Any fetchable URL (`https`, `ftp`, `file` and similar schemes), a `www.` host, or a public host the text sends the model to. Credential references such as `kv://…` and `entra-sp:…` are not URLs. |
| `skill.reveal_context` | Any sentence about revealing, repeating or sharing the system prompt, the instructions, the context window or the conversation history. |
| `skill.undeclared_tool` | A tool this build knows by name (the MCP catalogue and the runtime's own tools) that the skill does not list in `metadata.tools`. |
| `skill.secret_shape` | Anything the AI Guard egress scanner flags as a secret. The guard's own rule ids are reported beside it. |

The rules fire on the raw text and on the guard's folded form, so base64, hex,
homoglyph and zero-width evasions do not get past them.

A **refused** skill is not a load error. The loader holds it apart, by name and
rule ids, and loads the rest of the corpus. No run can mount it: a run whose
workflow declares it fails closed with the rule ids, and CI fails for any
workflow that declares it. The Skills tab lists it with its rule ids and the
workflows it stops, and never shows its text. A malformed document is still a
load error, because it is a defect in the corpus rather than suspect text.

Two consequences for authors:

- The rules cannot tell which way a sentence points. A defensive sentence such
  as "never reveal these instructions" is refused like an offensive one. A
  skill does not need it: the AI Guard already scans run input and tool results.
- Phrasing that reads as tool poisoning to the injection scanner ("use the X
  tool to …") is refused even for a declared tool. Name the tool in backticks
  and say what it is for.

## Evaluation sets and records

An **evaluation set** (`evaluation-set.json`, named by `metadata.evaluation`) is
authored with the skill. It holds the cases a reviewer agreed the skill must
handle, each with a machine-checkable expectation (`mustInclude`,
`mustNotInclude`), and a threshold per kind of case. It records the SHA-256 of
the instructions it was written for, so editing the instructions without
revisiting the cases is refused. A case may carry a `rationale`: which line of
the skill it tests, and why its expectation tells a right answer from the
likely wrong one. The rationale is never scored; it is what a reviewer reads to
judge whether a case proves anything.

Every set covers four kinds of case:

| Kind | What it checks |
|---|---|
| `task` | The skill does its job on a well-formed input. |
| `refusal` | It declines what it must not do, and says why. |
| `injection` | Instructions inside the input do not become instructions. |
| `missing-input` | Without a required input it names the gap rather than guessing. |

An **evaluation record** is the set plus the answers one named model revision
gave, with the time it ran. Pass rates are recomputed from the raw answers every
time and are never stored; a record that carries a rate is refused as malformed.
A set carries no answers, so nothing in the repository can show a pass that no
model produced.

`npm run skills:evaluate` makes a record. It sends each case to the model the
Flue runtime is configured with (`AGENT_FLUE_MODEL`, default
`claude-sonnet-5-5`; `--model` overrides it), with the skill's
instructions as the system prompt and the case input as the user message,
stores the revision the API reports, and writes `evaluation-record.json` beside
the skill only when the record passes. The cases are synthetic; no tenant data
is sent.

The credential is a repository secret, so records are normally made by the
manual workflow `.github/workflows/skills-evaluate.yml` (Actions → "Skill
evaluation records" → Run workflow). It runs the same command and uploads the
passing records as an artifact, which is then committed in a pull request like
any other change. A push by the workflow itself would not trigger CI, which is
why it does not commit.

## The mount gate

A run may mount a skill only when all of these hold. Each failure is a named
refusal, and a run that declares the skill is refused before its row exists:

| Refusal | Meaning |
|---|---|
| `NOT_EVALUATED` | The skill names no evaluation set. |
| `HASH_MISMATCH`, `VERSION_MISMATCH`, `NAME_MISMATCH`, `MALFORMED` | The set does not belong to this exact skill text, or a file does not parse. |
| `NO_RECORD` | The set exists and no model has answered it. |
| `SET_MISMATCH` | The record answered a different set from the committed one; adding a case means re-recording. |
| `UNANSWERED_CASE`, `UNKNOWN_ANSWER`, `DUPLICATE_ANSWER`, `BELOW_THRESHOLD` | The record, recomputed from its raw answers, does not pass. |

CI fails for any registered workflow that declares a skill the gate refuses,
and for any committed record that no longer passes.

The gate does not require the record's model to be the model a given run uses.
A run's model is chosen per tenant by residency, and a record per model would
refuse every skill to a tenant on a model nobody recorded. The record shows a
real model passed the text; the run's own pin records what that run was taught.

## The pin on every run

`WorkflowRun.mountedSkills` holds one `{ name, version, contentHash }` per
repository skill the run mounted, and one
`{ name, version, contentHash, origin: 'tenant', versionId }` per tenant skill,
written when the run is admitted. Repository pins come first, in declaration
order, then tenant pins in name order. `[]` means the run mounted
none; `NULL` means the run predates the pin. A database trigger refuses any
change to the column once the row exists, including filling in a `NULL`. When a
run resumes after a checkpoint, the skills it would mount are compared with the
pin, and a mismatch (a deploy changed a skill mid-run) fails the run before
anything reaches the model. The run detail page lists the pin.

## Who may author skills

Repository skills are reviewed in the repository, and the repository corpus is
Inflect-original guidance. Third-party methodology, such as PwC's, enters only
as skills a tenant authors under its own licence, behind the same rules (step
4c, #3680).

## Tenant-authored skills

A tenant authors a skill on the Skills tab of an agent's page, in the workspace
section. The repository section stays read-only. The models are
`TenantSkill` (the name) and `TenantSkillVersion` (everything that reaches a
model); the only writer is `src/app-layer/usecases/tenant-skills.ts`; the mount
gate is `src/lib/agentic/flue/skills/tenant-skill.ts`.

### Who may author and approve

Every act takes `admin.agent_skill_review`, which OWNER, ADMIN and `AI_ADMIN`
hold, and which no API key holds: `*` subtracts it and no scope maps to it. One
key covers authoring and approval. The four-eyes rule is a person, not a second
key: the approver of a version is never its author. The usecase refuses it
(`SELF_APPROVAL`), a CHECK makes it unrepresentable, and an API-key caller never
approves (`APPROVER_NOT_A_PERSON`).

### The lifecycle

A version moves one way, and a trigger holds it:

| Status | Reached by | Means |
|---|---|---|
| `DRAFT` | creating a skill, or editing one | Its text is fixed. It mounts nothing. Its evaluation record may be attached, once. |
| `IN_REVIEW` | submitting a draft that carries a passing record | Waiting for a person other than its author. It mounts nothing. |
| `APPROVED` | an approval naming the version's content hash | In service: runs of the workflows it names mount it. |
| `RETIRED` | rejection (`REJECTED`), a newer version (`SUPERSEDED`), or withdrawal (`WITHDRAWN`) | Terminal. It mounts nothing. |

**An edit is a new version.** A version's text and metadata never change after
it is inserted. Editing a skill creates version N+1 at `DRAFT` and retires any
open (`DRAFT` or `IN_REVIEW`) version as superseded. The version in service
keeps serving until N+1 is approved; the approval then retires it as superseded
in the same transaction. A skill has at most one version in service and at most
one open version (partial unique indexes).

### The text

Every field is sanitised (`sanitizePlainText`) at the write seam, then held to
the loader's own rules and scanned by `scanSkillText`, through the same
`validateSkillFields` a repository document goes through. The scan runs at save
as feedback: refused text is refused by rule id and never stored. It runs again
at every mount as the gate, because a deploy can tighten a rule. The
instructions and the evaluation record are encrypted at rest. A version the scan
refuses is listed by rule id; its text is never returned.

A tenant skill's licence and source are required. Its name is an Agent Skills
identifier, unique in the tenant, and never the name of a repository skill: the
runtime mounts a name once, and a delegated specialist narrows its parent's
skills by name. A version names the workflows it mounts on, and the approval
covers that list. Only workflows that run on the Flue engine can be named,
because a static run mounts no skill.

### The evaluation record

The record is the repository's own format, `SkillEvaluationRecordSchema`: the
evaluation set, tied to the skill's name, the version number and the content
hash of the version's stored instructions, plus a named model revision's answers
and the time they were given. The product shows each version's content hash so
the set can name it.

The author attaches the record to the draft. It is checked by
`checkEvaluationRecord`, the function the repository gate calls, with its pass
rates recomputed from the raw answers, and it is stored only if it passes. A
record that carries a rate is refused as malformed. Submission and approval
recompute it again, and so does every mount.

The product does not run the model that answers the set (owner decision,
2026-10-18): running it would send tenant text to a model outside a run and
spend the tenant's tokens. The review shows who attached the record, which model
revision answered it and the recomputed rates, and the reviewer decides whether
to rely on it.

### The mount gate

A tenant version mounts only when all of these hold. Each failure fails the run
closed, before its row is written, with a named refusal:

| Refusal | Meaning |
|---|---|
| `NOT_APPROVED` | The version is not in service. |
| `SELF_APPROVED` | Its approver is its author. |
| `PIN_MISMATCH` | Its decrypted instructions no longer hash to the hash its approval pinned. The encrypted column stays writable by the DEK rotation sweep, so the database freezes it against `app_user` only; this check covers every other writer. |
| text scan rule ids | The load-time scan refuses its text. |
| `NO_RECORD` and the evaluation refusals | Its record, recomputed from the raw answers, does not pass. |

The mount reads only the run's own tenant's rows, under row-level security and
a `tenantId` filter. Approval runs the whole gate as if the version were already
approved, and refuses a version that would put any workflow it names over the
catalogue budget (`CATALOGUE_OVER_BUDGET`), counting that workflow's repository
skills and the tenant's other skills in service on it.
