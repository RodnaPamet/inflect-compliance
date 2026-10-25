---
name: babysit
description: Watch a pull request in this repository through CI, review and the merge queue until it merges. This repository keeps that guidance in the steward skill; read .claude/skills/steward/SKILL.md and follow it.
---

# Babysitting a pull request in inflect-compliance

Read [`../steward/SKILL.md`](../steward/SKILL.md) and follow it. It is this
repository's only guidance for driving a pull request to merge: when to open
and merge, what green means, how the merge queue behaves, and which bot
comments need nothing.

This file exists so that a session looking for a `babysit` skill finds the
same rules as one looking for `steward`. It holds no rule of its own. A rule
added here would be a second copy that drifts from the first, so put it in
`steward` instead.
