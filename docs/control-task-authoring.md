# Authoring control tasks

The standard every control task in the catalogue is written to. It exists
because the catalogue holds 345 control templates, and a task set for each of
them runs to well over a thousand tasks. At that volume human review becomes a
rubber stamp, so the bar is written down here, and every part of it a machine
can decide is decided in CI by
`tests/guardrails/control-task-conformance.test.ts`.

## The acceptance test

> **Could a named person finish this on a specific Tuesday and attach evidence?**
> If not, it is a heading, not a task.

Everything below is a consequence of that sentence. When a rule and the
sentence disagree, the sentence wins.

## Required

- **An imperative title, one action, scoped to a single deliverable.**
  "Inventory the cryptographic keys in use", not "Cryptography management".
- **A description carrying the *how* and the evidence expectation** — what
  gets attached when the task is done. A description that only restates the
  title has told the assignee nothing.
- **3–6 tasks per control.** A control with fifteen tasks guarantees
  bulk-completion, which fails in the same way as a control with none.
- **Every task grounded in the control's own metadata.** Do not assert an
  obligation the control text does not carry — no invented deadlines, no
  invented artifacts, no invented approvers.

## Reject

- **Generic boilerplate**: "Review control", "Update documentation", "Assign
  owner", "Check compliance". *If the title would fit under any control in the
  catalogue, it belongs under none of them.*
- **Tasks that restate the control text.** The control already says what it
  requires; the task says what somebody does about it.
- **Tasks with no observable completion state.** "Ensure keys are managed
  securely" cannot be finished. "Record the rotation interval for every key in
  the register" can.

## The worked example

ISO 27001 **A.8.24 — Use of cryptography**. Its entire published text is
*"Define and implement cryptography rules"*, which is exactly the shape that
tempts a generic answer.

### The naive task set — all four are rejects

| task | why it fails |
|---|---|
| Review the cryptography policy | Fits under any control. No deliverable. |
| Implement cryptographic controls | Restates the control. Not finishable. |
| Assign a control owner | Boilerplate; true of all 345 controls. |
| Check compliance with the policy | No observable completion state. |

Every one passes a careless read, and a catalogue of them is indistinguishable
from having no tasks at all — which is the state this work exists to leave.

### The same control, authored

| phase | task | evidence |
|---|---|---|
| SCOPE | Inventory every system and application using cryptography | the inventory, listing system, algorithm and purpose |
| IMPLEMENT | Record the approved algorithms and minimum key lengths for each use | the standard, showing algorithm per use case |
| IMPLEMENT | Record generation, distribution, rotation and destruction for every key | the key register, one row per key |
| OPERATE | Log every key generation, rotation, revocation and destruction | the key-management log for the period |
| REVIEW | Reconcile the key register against the systems inventory | the reconciliation, with discrepancies and their resolution |

Each names a deliverable that can be attached. Each could be finished on a
Tuesday. None would fit under a different control.

Note what is *absent*: no "review the policy", no "ensure compliance", and no
deadline — A.8.24 carries none, so asserting one would be inventing an
obligation.

## Grounding

Author from the control's own fields, in this order:

1. `objective` — what the control achieves. Usually the SCOPE task.
2. `successCriteria` — what "passing" looks like. Usually the REVIEW task.
3. `testingMethodology` — the richest field, and often literally structured as
   **Evidence:** then **Analysis:**. The Evidence list is the best source for
   `evidenceHint`, because it names the artifact an auditor will ask for.
4. Linked requirement text.

**If the metadata does not carry it, do not write it.** A control whose
material supports only three tasks gets three tasks. Padding to reach six
reintroduces the boilerplate this document exists to prevent, and it is worse
than a short task set because it looks complete.

Where a framework's metadata is too thin to ground specific content — most of
them, outside `ICN-` — say so in the PR rather than synthesising. Note that
**ISO 27001 Annex A has no control templates at all**: its 93 entries are
`FrameworkRequirement` rows, so there is nothing to attach tasks to until
templates exist.

## Phases

`TaskPhase` is a reading order, not a state machine. Nothing transitions;
`TaskStatus` owns progress.

| phase | what belongs there |
|---|---|
| `SCOPE` | establishing what is in scope — inventories, registers, definitions |
| `IMPLEMENT` | putting the control in place — standards, configuration, procedure |
| `OPERATE` | running it — the recurring act that produces evidence |
| `REVIEW` | checking it still works — reconciliation, testing, assessment |

An `OPERATE` task **must** carry an `evidenceHint`: it is the phase whose whole
output is proof, and a recurring task with no named artifact is the one most
likely to be closed without doing anything.

## Fields

```jsonc
{
  "title":       { "en": "Inventory every system and application using cryptography" },
  "description": { "en": "List each system, the algorithm it uses and what it protects. Attach the inventory." },
  "phase":       "SCOPE",
  "sortOrder":   0,
  "evidenceHint":{ "en": "The cryptographic systems inventory" },   // required on OPERATE
  "suggestedRole": "Security engineering",
  "steps": [                                                        // optional; see below
    { "text": { "en": "..." }, "hint": { "en": "..." } }
  ]
}
```

- **`steps` are optional and are not padding.** Include them where a task
  genuinely decomposes into actions somebody ticks off; omit them where the
  description is the whole instruction. When present: 3–8 steps, none shorter
  than 25 characters. A step that repeats the description is a reject.
- **`suggestedRole`** comes from: IT Operations, Security engineering,
  Engineering lead, HR, Legal/DPO, Facilities, Management, Procurement. Where a
  control genuinely spans owners, put the *accountable* role here and name the
  others in the description — one task, one owner.
- **`sortOrder`** is the authored reading order and is what the installer sorts
  by. Contiguous from 0.
- **`en` is required**; other locales are optional and ride in `i18nJson`.

## What CI checks, and what it cannot

`control-task-conformance.test.ts` mechanically rejects: boilerplate titles
from a frozen list, non-imperative titles, titles that duplicate the control
title, descriptions that merely restate the title, missing `evidenceHint` on
`OPERATE`, task counts outside 3–6, and steps outside 3–8 or under 25
characters.

It **cannot** tell whether a task is grounded, whether the evidence named
actually exists, or whether a plausible-sounding obligation was invented. Those
are what human review is for, which is why the mechanical gate exists — to stop
reviewers spending their attention on things a regex can catch.
