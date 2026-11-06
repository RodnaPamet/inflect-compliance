# 2026-11-06 — The automation canvas, connected to its rules

**Commit:** see the pull request for this branch (`claude/canvas-rules-connect`).

The owner's direction: on an automation map, the canvas should actually
configure the rules. Their decisions, from the questions put to them:

- Steps wired into an Action or Agent step edit that step's rule. One source of
  truth, `AutomationRule`; the Rules tab stays a full editor of the same rules.
- An action's settings are edited in the existing rule builder, opened from the
  step.
- Also: rule status on the steps, "Open on canvas" from the Rules tab, rules
  named after their steps, and no enabling an unconfigured rule.

## What was disconnected

The VR-3 bridge (`canvas-rule-sync.ts`) existed. Saving an automation map gave
each Action or Agent step a DRAFT rule, and `dataJson.ruleId` linked them. Four
breaks kept the canvas from configuring anything:

1. **Every save made another rule.** `replaceGraph` stores each node's
   `dataJson` as the browser sent it. The sync wrote the new `ruleId` onto the
   stored node after that, and the browser never read it back. So the next
   save, autosave included, sent the step without a link, and the sync created
   another rule. That repeated for as long as the map stayed open.
2. **The inspector never showed the rule panel on the tldraw canvas.** It keys
   on `data.kind`, a field from the xyflow canvas. A tldraw step keeps its kind
   in `nodeType` and its links inside `dataJson`, and the selection adapter
   passed the props through unchanged. The same gap hid the per-kind pickers
   that link a Risk step to a risk.
3. **Trigger and Condition steps could configure nothing.** The panel took one
   `ruleId`, and only Action and Agent steps have one. A Trigger step could only
   say it was not synced.
4. **A stub rule could be enabled empty.** Its placeholder trigger was
   `RISK_CREATED`, and its action had no recipients.

## Design

```
 Trigger ──▶ Condition ──▶ SLA ──▶ Action (owns rule R)
   │            │           │         │
 R.triggerEvent R.filter   R.sla     R.name / status / action (rule builder)
```

- **Which rule a step configures:** `src/lib/processes/canvas-rule-wiring.ts`
  follows a step's outgoing connections through Trigger, Condition and SLA
  steps to the Action or Agent steps they reach. It is pure, and the selection
  adapter puts its answer on the inspector's data as `fedRules`. The set of
  rule-owning kinds lives there too, and the server re-exports it, so the two
  cannot disagree.
- **The link survives every save:** `prepareCanvasNodesForSave` keeps the
  stored `ruleId` for a step that arrives without one, matched by the same
  `nodeKey` only, and drops the display-only fields the load merges in. The
  save returns each step's `ruleId`, and `applySavedRuleIds` attaches it to the
  open canvas as a remote, history-ignored change, so the map is not marked
  dirty and undo cannot remove it.
- **Readiness:** `src/app-layer/automation/rule-readiness.ts` lists what a rule
  lacks: an unset or unknown trigger, a SCHEDULE trigger with no schedule, or
  an action config its own schema rejects. A write that leaves a rule ENABLED
  while it lacks something is refused inside the write's transaction. Every
  rule the usecases return carries `readiness`, so the step, the panel and the
  sheet all show the server's answer.
- **A new step's rule:** it is named after the step's label, and its trigger is
  `UNSET`, which is not an event, so the dispatcher can never select it.
- **Status on steps:** `CanvasRuleStatusProvider` reads the live rules list,
  the same SWR key the Rules tab, the panel and the builder revalidate, and
  passes translated text to the step body, which has no translator.
- **Rules tab → canvas:** `getAutomationRule` returns `canvas` (map, step),
  found from the node side (`dataJson.ruleId`), where the VR-3 invariant keeps
  the link. "Open on canvas" links to `?activeId=…&step=…`. The page switches
  to the Canvas tab, and the canvas selects the step.

## Files

| File | Role |
| --- | --- |
| `src/lib/processes/canvas-rule-wiring.ts` | New. Which rules a step configures; rule-owning kinds. |
| `src/app-layer/automation/rule-readiness.ts` | New. What a rule lacks; the refusal. |
| `src/app-layer/services/canvas-rule-link.ts` | New. A rule's canvas step (a leaf, to avoid an import cycle). |
| `src/app-layer/services/canvas-rule-sync.ts` | Save preparation; stub name and trigger; returns ids. |
| `src/app-layer/usecases/process-map.ts` | Uses the preparation; returns each step's rule id. |
| `src/app-layer/usecases/automation-rules.ts` | Readiness enforced and returned; `canvas` on the detail. |
| `src/lib/processes/use-tldraw-selection.ts` | Inspector data: `kind`, links, `fedRules`. |
| `src/components/processes/AutomationInspectorPanel.tsx` | Edits the rules a step configures; opens the builder. |
| `src/components/processes/tldraw/apply-saved-rule-ids.ts` | New. A save's rule ids onto the open canvas. |
| `src/lib/processes/canvas-rule-status.tsx` | New. Live status for the step body. |
| `RuleDetailSheet.tsx`, `RulesTab.tsx`, `ProcessesClient.tsx` | "Open on canvas", readiness, "Not set". |

## Decisions

- **The link is carried forward on the server, not only fixed in the browser.**
  A browser that has not loaded the new code, or a stale tab, would otherwise
  keep making duplicates. The server fix alone stops them; the browser fix is
  what lets the panel use the new rule without a reload.
- **A Trigger that reaches several Action steps sets all their rules.** That is
  what the canvas draws. The panel names each rule it will change.
- **Readiness is checked on the written row, inside the transaction.** The
  check sees exactly what was stored, including fields the request did not
  send, and a refusal leaves nothing behind.
- **Existing rules are not re-validated.** Only a write that leaves a rule
  enabled is checked, so a rule enabled before this change keeps running until
  somebody edits it.
- **`UNSET` is a string, not a nullable column.** A migration for one sentinel
  was not worth it. The value cannot match any emitted event, and the Rules tab
  shows it as "Not set".
