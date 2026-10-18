---
name: iso-27001-annex-a-drafting
description: Draft or review an ISO/IEC 27001:2022 Annex A control implementation for a tenant, keyed to control identifiers. Use when asked to write, assess or improve the implementation description for an Annex A control, or to judge whether a stated implementation would satisfy an auditor.
license: proprietary
metadata:
  sourceRef: original drafting guidance; cites ISO/IEC 27001:2022 Annex A by CONTROL IDENTIFIER only
  version: '1'
  evaluation: evaluation-set.json
  isoText: none — no Annex A control titles or text are reproduced here (#3478)
---

Annex A control identifiers are stable across a tenant's estate; the control
*text* is ISO's. Work from the identifier and the tenant's own evidence, never
from recalled standard wording — a drafted implementation that paraphrases the
standard back at the reader states the requirement, not the answer to it.

## Drafting an implementation description

1. Name the identifier (`5.1`, `8.12`) and the theme it belongs to:
   organizational (5), people (6), physical (7), technological (8). If the
   request supplies no identifier, do not choose one from the facts: matching a
   practice to an identifier is recall of the standard, which this skill never
   relies on. Ask for the identifier, and draft nothing under a guessed one.
2. State **what this tenant actually does**, in the present tense, naming the
   system or document that does it. "Access is reviewed quarterly in the
   access-review module" is an implementation. "Access shall be reviewed" is a
   restatement of a requirement.
3. Name the **evidence** a reader could open. If no artefact exists, the control
   is not implemented, however well described: say that it is
   "not implemented", in those words, and cite as evidence no artefact the
   input did not supply.
4. Name the **owner** by role, never by person.

## Reviewing one

State each review verdict against the identifier it concerns, then the reason,
in the form `<identifier>: reject — <reason>` (or `accept`); when a description
claims several identifiers, name each one. A verdict that does not name its
identifier cannot be filed against the control.

Reject, with the reason, when the description:

- restates the requirement instead of the practice;
- uses `shall`, `should`, or `must` — those belong to the standard, not to a
  description of what is already true;
- claims a frequency with no artefact showing the last occurrence;
- cites a tool without saying what the tool is configured to do;
- covers several identifiers at once. One identifier, one description; a shared
  practice is cited from each, not described once.

## Scope boundaries

Applicability is a Statement of Applicability decision — use the `soa-authoring`
skill. Whether the cited artefact is sufficient evidence is a separate judgement
— use `evidence-sufficiency`.

Never assert that a control "meets ISO 27001". Controls are implemented; a
management system is certified, by an accredited body, against the whole.
