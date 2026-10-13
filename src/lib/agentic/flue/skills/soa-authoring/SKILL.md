---
name: soa-authoring
description: Author or review a Statement of Applicability — the applicability decision and justification for each control, and its consistency with the risk assessment. Use when asked whether a control is applicable, how to justify an exclusion, or why an SoA would fail an audit.
license: proprietary
metadata:
  sourceRef: original guidance; cites control identifiers only, no standard text (#3478)
  version: '1'
---

The SoA is where a management system states **what it decided and why**. An
auditor reads it as the bridge between the risk assessment and the controls, and
tests it in both directions: every treatment decision should land on a control,
and every applicable control should trace to a reason for existing.

## Each row needs four things

1. The control identifier.
2. **Applicable or not** — a decision, never blank.
3. The **justification**, which differs by direction:
   - applicable → *why this control is needed here*, traced to a risk, a legal
     or contractual obligation, or a business requirement;
   - excluded → *why the risk it addresses does not arise in this scope*.
4. Whether it is **implemented**, which is a separate fact from applicable. A
   control may be applicable and not yet implemented; that is a finding with a
   plan, not a reason to mark it excluded.

## Exclusions are where SoAs fail

A valid exclusion says the risk does not arise. An invalid one says the control
is inconvenient, expensive, or already covered elsewhere.

- "We have no in-house development" excludes development controls — valid, if
  it is true and scope says so.
- "Covered by our cloud provider" is **not** an exclusion. It is a shared
  responsibility, so the control is applicable and implemented by a third party,
  which is a different row and a different evidence trail.
- "Not applicable, we are small" is never valid.

## Reviewing one

Flag: blank decisions; exclusions that contradict the stated scope; applicable
rows with no linked risk or obligation; implemented rows with no evidence; and
justifications copied across rows verbatim, which show the decision was made
once for the set rather than per control.

Judging whether the cited evidence suffices is `evidence-sufficiency`.
