# 2026-07-29 — Automation action vocabulary + builder round-trip

**Commit:** `<sha>` fix(automation): complete the action-type vocabulary; let the builder edit and clear a description

Closes the remaining four findings from the prompt-2 audit round. Two needed
code; two were already fixed before the audit claimed them open.

| Finding | Outcome |
|---|---|
| P2.3 — `linkEntityType` free text | **Already fixed** in #1697. Verified only. |
| P2.4 — `INVOKE_SUBFLOW` missing from filter + inspector | Fixed. |
| P2.5 — dead `DOCUMENT` governance branch | **Already fixed** in #1697. Verified only. |
| P2.6 — description unclearable, silent SLA recipient loss | Fixed. |

Two of four findings landed five days before the audit round that reported them
as open — the same pattern as P2.2 in the previous PR. Recorded because
"verified already fixed" and "not looked at" are indistinguishable in a diff.

## P2.4 — one enum, five hand-written lists, two of them short

`INVOKE_SUBFLOW` existed in the Prisma enum, the Zod config union, the executor
and the Rule Builder. It was missing from exactly two places, both hand-written
lists, and every consequence was silent:

- the Rules tab's **Action filter could not select sub-flow rules at all** — they
  were unfindable by the attribute that defines them;
- `buildRuleActionLabels` had no entry, so the rules table and the detail sheet
  fell through to the raw `INVOKE_SUBFLOW` string;
- the canvas inspector's action picker had no matching option, so selecting a
  sub-flow node rendered an **empty** control.

Fixing three lists fixes today. `tests/guards/automation-action-vocabulary.test.ts`
fixes tomorrow: it reads the enum out of `enums.prisma` and asserts every member
is present in the union, the label builder, both message catalogues, the
inspector, and `ACTION_CONFIG_BY_TYPE`. The next enum member cannot be added
without wiring — the same shape as the route field-forwarding guard.

## The inspector's action picker is now read-only, and that is the fix

The finding asked the inspector to "reset/migrate `actionConfig` on action-type
change". **There is no valid config it could substitute.** Every action config
carries at least one required field:

| Action | Required |
|---|---|
| `NOTIFY_USER` | non-empty `userIds`, `message` |
| `CREATE_TASK` | `title` |
| `UPDATE_STATUS` | `entityType`, `field`, `toStatus` |
| `WEBHOOK` | `url` (must parse as a URL) |
| `INVOKE_SUBFLOW` | `targetGroupId` |

So a reset produces an invalid rule, and a migration has nothing to migrate —
no two configs share a field. Since P1.7 the server validates the incoming
action type against the **stored** config, so a bare type flip is rejected with
a 400 the panel never reads. The control could only ever fail.

It is now a labelled read-out plus a sentence naming where the edit belongs —
which is exactly what the condition branch two lines below already does for
filters. Removing a control that cannot succeed is not a capability loss.

## P2.6 — the description was write-once, and the SLA recipients vanished quietly

**Description.** `buildRulePayload` never sent the field. The repository skips
`undefined`, so a description was permanent once written — and templates
(`src/data/automation-templates`) always write one. The builder had no
description input at all, so the only way to change a template rule's
description was the API.

The payload now always carries the key: `form.description.trim() || null`.
Sending `null` is what CLEARS it; omitting the key means "leave it alone", which
is the bug.

**SLA recipients.** Clearing `slaWindowMinutes` nulls `slaBreachConfig` in the
payload *and* unmounts the whole breach block, so the recipient list disappears
from the screen at the same moment it disappears from the save. Nothing said so.

The state still holds the list, which is what makes the loss both silent and
**recoverable** — retype a window and the recipients come back verbatim. A
`warning` `InlineNotice` now says exactly that, and a test pins the round-trip so
the claim in the copy stays true.

## Decisions

- **A warning, not a confirm dialog.** The loss is undoable until save (state
  survives the clear), so blocking the interaction would be heavier than the
  risk. The notice appears at the point of the edit rather than as a toast after
  it, because by toast time the user has already left the field.

- **`description` is `string | null` and REQUIRED on `RuleDetail`.** The detail
  endpoint reads the full row (no `select`), so it is always present. Typing it
  optional would let a future caller construct a detail without it and silently
  re-introduce the clear-is-impossible bug.

- **The guard reads `enums.prisma`, not a TypeScript constant.** A guard that
  compared two hand-written lists would pass while both were short. The Prisma
  enum is the one place the value has to exist for the column to accept it.
