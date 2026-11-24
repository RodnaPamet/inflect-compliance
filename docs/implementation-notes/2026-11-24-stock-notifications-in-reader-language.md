# 2026-11-24 — Stock notifications in the reader's language

**Issue:** #5929 (part of #5868)

## Design

A notification row is written once, at emit time, for a recipient whose
language the server does not know (the UI locale is a per-browser cookie), so
the row stores English. Before this change the assignment, task-due,
watched-task, NIS2 and a dozen other notifications were shown exactly as
stored, so a Bulgarian reader saw "You were assigned a task" and
"… is now yours." on `/notifications` and in the bell. No catalogue message
held those sentences, so the mobile audit's leak detector could not tell them
from tenant data either.

`src/lib/notifications/stock-notifications.ts` follows the agentic modules'
pattern (`agentic-titles.ts`, `agentic-bodies.ts`) and generalises it:

```
STOCK_NOTIFICATIONS[KIND] = { type, title: template, body: template, freeBody? }

emitter ──stockNotificationTitle/Text(KIND, params)──▶ Notification row (English)
reader  ──localizedStockNotification(row, tTitles, tBodies)──▶ { title, message } | undefined
          1. kinds with row.type
          2. parse the title against the kind's title template
          3. parse the body against the kind's body template
          4. word each placeholder: data as written, product phrases translated
          5. render notificationTitles.stock.KIND / notificationBodies.stock.KIND
```

The kind is decided by type, title and body together, so a GENERAL row (NIS2,
framework update, A2A invitation, SCIM, SLA) is only re-worded when all three
are the product's. No column and no migration: the emitters write the same
bytes they always did, so rows stored before this change are re-worded too.
Anything that does not parse, or names a phrase the module did not write, is
shown as stored.

Each English template is the `en` catalogue message for its kind, held equal
by a unit test. That is what gives the leak detector
(`scripts/mobile-audit/leaks.ts`) a template: a stock row shown as stored is
now `CATALOG`.

## Files

| File | Role |
| --- | --- |
| `src/lib/notifications/stock-notifications.ts` | The templates, the slot phrases, the writer helpers and the reader |
| `src/components/layout/notifications-bell.tsx` | Loads the reader on mount with `import()`, words each row |
| `src/app/t/[tenantSlug]/(app)/notifications/page.tsx` | Words each row (static import) |
| `src/app-layer/notifications/{assignment,task-due,watcher,scim-deprovision}.ts` | Write through the templates |
| `src/app-layer/usecases/{gap-assessment-assignment,task,evidence,vendor-monitoring,vendor-reassessment-reminder,framework-delta,peer-invitations}.ts` | Write through the templates |
| `src/app-layer/jobs/{incident-notification-deadlines,sla-monitor}.ts` | Write through the templates |
| `messages/{en,bg}.json` | `notificationTitles.stock.*`, `notificationBodies.stock.*` |

## Decisions

- **Parse the stored English rather than add a params column.** The agentic
  modules already do this, and a column would leave every existing row in
  English. A migration would also make the change SIGNIFICANT for no gain.
- **The bell loads the reader lazily.** The bell is in the shell of every
  route, and the dashboard bucket had about 1 KB of First Load JS left.
  A static import added about 1 KB gzipped to every route; the dynamic import
  keeps the shell growth to the effect that loads it. Until the chunk lands a
  stock row is shown as stored, and it lands on mount, long before the list
  is opened. The `/notifications` page imports it statically: it is its own
  route with room to spare.
- **`freeBody` kinds.** Evidence review, the automation SLA breach and vendor
  posture alerts may carry a person's or a feed's own text in the body (a
  reviewer's comment, a rule's configured message). Their title is still
  worded and the body is shown as written.
- **Phrases the product writes into a slot are translated, data is not.** A
  question count, a respondent group, a watched-task change, an incident
  report's name and the "A member" / "Attestation" fallbacks have catalogue
  messages; a task's key and title, a vendor's name, a date are shown as the
  record holds them.
- **A watched task's change list is read piece by piece.** Its body is
  `{label}: {detail}`, where the detail is one or more changes joined by
  `, ` (a status move, a due-date move, a reviewer change, a comment, a
  reassignment). Each piece the module wrote is translated; one it did not
  write leaves the whole row as stored.
- **Not covered, by design:** automation rule notifications
  (`automation/action-executor.ts`) carry the rule author's own title and
  message, which are tenant data. The task a NIS2 dispatch creates is a
  record with an English title a person may edit, so a TASK_ASSIGNED row about
  it reads "TSK-9 "Answer the NIS2 gap assessment questions …" вече е ваша
  отговорност.": the sentence is Bulgarian, the record's title is not.
- **E-mail is unchanged.** The task-assigned e-mail is built by its own
  template (`notifications/templates.ts`), not from the bell's text, and goes
  out in English: there is no stored per-user locale to render it in.
