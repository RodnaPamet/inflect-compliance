# 2026-07-23 — Process-map starter templates + automation/governance polish

**Commit:** `<sha> feat(processes): starter templates + governance/SLA polish`

## Design

Four independent items closing a feature gap and clearing dead code around the
process/automation surface.

1. **Process-map starter templates.** Authoring a process map previously
   started from a blank canvas — the only `TemplateLibraryModal` in the product
   is AUTOMATION-rule-only. Added a DOCUMENT-map starter library: a handful of
   built-in compliance process shapes (access provisioning & review, vendor
   onboarding & due diligence, incident response) a user can clone. Reachable
   from the canvas empty state ("Start from a template") and the command
   palette ("New from template"). **Scope decision:** rather than a full
   server-side template system (tenant-authored/shareable templates, a
   gallery), this ships BUILT-IN starters defined in code. Cloning is a plain
   create-map + save-graph round-trip (mirrors the canvas Duplicate flow), so
   there is no new API, table, or migration. A richer template system remains a
   separate, larger piece. The automation-rule `TemplateLibraryModal` is kept
   distinct and clearly labelled (`ProcessTemplateModal` vs `TemplateLibraryModal`).

2. **Governance page — dead DOCUMENT branch removed.** `getGovernanceGraph`
   filters `canvasMode: 'AUTOMATION'`, so every governance node is an automation
   map. The page's `canvasMode === 'AUTOMATION' ? … : DOCUMENT` badge ternary was
   unreachable — collapsed to the AUTOMATION badge, and the `canvasMode.DOCUMENT`
   translation dropped from both locales. (A real compliance-governance view
   over DOCUMENT maps is a separate, larger piece.)

3. **RuleDetailSheet — full breach behaviour.** The read view showed only the
   SLA breach *action type*. It now also renders the breach recipients (count)
   and message from `slaBreachConfigJson`, so the sheet reflects the full
   configured breach behaviour.

4. **Orphan `slaReminderMinutes` removed.** The column was accepted by the
   create/update schemas and persisted by the repository, but no builder input
   ever set it and the `sla-monitor` watchdog never read it (it reads only
   `slaWindowMinutes` + breach action/config). A real reminder sweep would also
   need a per-execution "reminder sent" marker to avoid re-notifying every
   5-minute pass — a separate feature, not this reserved column. Dropped it
   end-to-end (schema, routes, repository, Prisma column + migration, guard).

## Files

| File | Role |
| --- | --- |
| `src/components/processes/process-map-templates.ts` | Built-in starter definitions + `buildTemplateGraph` (PUT-ready shape) |
| `src/components/processes/ProcessTemplateModal.tsx` | Starter picker modal (distinct from the automation `TemplateLibraryModal`) |
| `src/components/processes/PersistedProcessCanvas.tsx` | `handleNewFromTemplate` clone flow; empty-state + palette triggers; modal mount |
| `src/app/t/[tenantSlug]/(app)/processes/governance/page.tsx` | Dead DOCUMENT badge branch removed |
| `src/components/processes/RuleDetailSheet.tsx` | Breach recipients + message; structural narrowing of the widened `triggerFilterJson` |
| `prisma/schema/automation.prisma` + migration | Drop `slaReminderMinutes` |
| `src/app-layer/{schemas/automation.schemas,automation/types,automation/AutomationRuleRepository}.ts`, both rules routes | Remove `slaReminderMinutes` plumbing |
| `messages/{en,bg}.json` | Template + breach strings; DOCUMENT badge string removed |

## Decisions

- **Built-in starters, not a template system.** The gap is "every map starts
  blank"; a few cloneable built-ins close it with zero new backend surface. A
  full gallery is deferred.
- **Structural narrowing in RuleDetailSheet.** Bug 1 (earlier this day) widened
  `RuleDetail.triggerFilterJson` to `FilterGroup | legacy-map | null`. The read
  sheet summarises flat leaf conditions of a group; it narrows structurally
  (the `Raw*` types aren't exported) and skips legacy maps / nested sub-groups
  in the condition list — the full shape is still preserved for editing.
- **Drop, not wire, `slaReminderMinutes`.** Wiring a reminder correctly needs a
  dedup marker column — scope creep for a reserved field nothing populates.
