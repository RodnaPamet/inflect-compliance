# 2026-11-25 — Task-assigned email in the workspace's default language

**Commit:** `feat(i18n): the task-assigned email is written in the workspace's default language`

## Design

Owner decision 2026-11-25: the task-assigned email is written in the
workspace's default language (`Tenant.defaultLocale`, added in #5932).

An email is rendered once, when it is enqueued: `enqueueEmail` builds the
subject and both bodies and stores them on the `NotificationOutbox` row, and
the dispatcher sends the row as stored. So the language is chosen there, at
enqueue, from the tenant id every enqueue already carries. Nothing on the send
side changes.

```
task.ts::enqueueTaskAssignedNotification (caller's tenant transaction)
        │
        ▼
enqueueEmail(db, { tenantId, type: 'TASK_ASSIGNED', payload })
        │  isSingleTaskAssigned?  ── no ──► every other template, unchanged (English)
        │  yes
        ▼
readWorkspaceLocale(db, tenantId)  ── one read per email, in the same transaction
workspaceTranslator(locale, 'workspaceText.taskAssignedEmail')
        │
        ▼
buildTaskAssignedEmail(payload, t) ──► NotificationOutbox row (subject, text, HTML)
```

## Files

| File | Role |
| --- | --- |
| `src/app-layer/notifications/templates.ts` | `buildTaskAssignedEmail` takes the workspace translator; `htmlMessage` escapes a message's text and places pre-built HTML fragments |
| `src/app-layer/notifications/enqueue.ts` | Reads the workspace language for the single-task TASK_ASSIGNED email only, and hands the translator to the template |
| `messages/{en,bg}.json` | `workspaceText.taskAssignedEmail.*`; the admin card's description names the email |

## Decisions

- **Read at enqueue, not at send.** The outbox row is the rendered email; the
  dispatcher has no template step to translate in. Enqueue already runs in the
  caller's tenant transaction with the tenant id, so the read is one
  `Tenant.findUnique` there, and only for this email.
- **Reuses `workspace-text.ts`.** No second translation path: the same
  `workspaceTranslator` / `readWorkspaceLocale` the NIS2 task titles use, and
  an unknown stored value reads as English through `resolveLocale`.
- **English is pinned byte for byte, `audit_finding` included.** The old email
  printed the task type as the lower-cased enum value. The English catalogue
  keeps that spelling so an English workspace receives exactly the email it
  received before; the Bulgarian catalogue words each type properly. A type
  the catalogue does not word is printed as before.
- **The by-line is two messages, not a fragment.** "assigned" and "assignedBy"
  are whole sentences, because Bulgarian puts the assigner first
  ("Bob ви възложи задача…"); concatenating an English " by X" suffix does not
  translate.
- **HTML: the message is escaped, the fragments are not escaped twice.** Values
  go through the translator as opaque tokens, the result is escaped, and the
  tokens are replaced by the `<strong>` fragments built from escaped data. A
  catalogue sentence can never inject markup, and a task title or name is
  escaped exactly once.
- **Only this email.** The bulk-assign digest rides the same
  `TASK_ASSIGNED` type and stays English, and reads no language; so does every
  other email. The owner decided this email only; the others are listed in the
  PR as candidates.
- **Data stays as written.** The task key and title and the assignee's and
  assigner's names are interpolated unchanged; the product name in the sign-off
  is not translated.
