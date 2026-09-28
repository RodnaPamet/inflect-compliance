# 2026-09-27 — the Art 12 / Art 14 record for an agent-driven external write (#2861)

**Commit:** `<pending> feat(agentic): ExternalWriteJournal, and the seam that writes it`

## Design

Two owner decisions from 2026-09-27 made structural.

**Mirror the JML journal rather than invent a format.** Per write: actor, agent,
connection, tool, arguments sent, prior state, outcome, and the rung it ran under.
That shape already survived a real regulator-facing directory disable and reuses a
surface operators know.

**Rollback is CAPTURE, not auto-revert.** The table records what a write REPLACED
so a human can re-apply it in the far system; nothing here re-sends anything, the
same way `DirectoryWriter` declares no `enable()` verb. So there is deliberately
**no `REVERTED` outcome**: nothing could set it, and #2241 is the record of what a
value that enforces nothing costs. Appending an enum value later is safe; dropping
one is the hazard.

`priorStateJson` is **NOT NULL**, which is owner decision 2 expressed in the
schema: reading prior state is a precondition of dispatching and unreadability is
a refusal, so a row without it could only exist if something wrote blind. The
column makes that unrepresentable rather than merely discouraged.

## Two things the schema had to get right, and one it got wrong first

**The payload columns are `String`, not `Json`.** `encrypted-fields.ts` states the
constraint — "this manifest encrypts STRING fields only" — which is why
`AgentProposal.payloadJson` and `WorkflowStep.inputJson` are strings despite their
names, and why `IdentityWriteJournal.priorStateJson` is `Json` and "cannot be"
encrypted. No jsonb querying is lost that anything needs: the journal is read a
row at a time, and the dwell counts rows by `mode` and `outcome`.

**And they ARE encrypted, departing from the identity journal.** That table leaves
its prior state in the clear, and its manifest comment gives the reason: it "holds
structured directory attributes (`accountEnabled`, `userAccountControl`, group
names) rather than credentials, and the table is RLS-scoped". That reasoning turns
on CONTENT and does not transfer. This column holds whatever an arbitrary
third-party system returns for the object being changed, and the first writable far
end is an HRIS — where the prior state of a contact-details record is a person's
work email, personal email and phone numbers. Same RLS scoping, different content.

**The FK was wrong first, and a test caught it.** Written as a composite FK with
plain `ON DELETE SET NULL`, which fails outright: Postgres nulls EVERY referencing
column, and `tenantId` is NOT NULL. `20260913020000_tenant_fks_setnull_batch3b`
states exactly that rule. The RLS suite's outlives-the-connection test deletes a
real connection rather than asserting the constraint text, which is why it
surfaced as a null-constraint violation instead of shipping.

## What one new model owed: six registrations, found in three rounds

None findable by a symbol-grep — every one enumerates the model list — and each
round's fix pulled in the next:

| guard | what it wanted |
| --- | --- |
| `data-retention` | an inventory row classifying it (Regulatory artefact) |
| `encryption-manifest-coverage` | `detail` encrypted or justified — it flagged the column by NAME shape |
| `tenant-isolation-forward-lock` | classified TESTED, pointing at a real two-tenant RLS suite |
| `sanitize-rich-text-coverage` | a classified write seam — `KNOWN_UNCOVERED` is at ZERO and capped there, so parking it was not available |
| `tenant-purge` | added to the retain list, because the retention doc calls it a regulatory artefact |
| `usecase-has-importing-test` | behavioural coverage of the seam |

The fourth is the one that changed the design rather than adding a line. The
sanitiser guard cannot be satisfied by a promise, so it forced the write seam into
existence — which also resolved the thing that would otherwise have been wrong
about this PR: a model with no writer.

## `detail` is sanitised, and the reason is stronger here than upstream

The identity journal sanitises because a revert reason is operator free text. Here
`detail` is never operator-authored — it is the FAR END's rejection message. That
is a stronger case, not a weaker one: untrusted text, written by a third party,
stored, and later rendered on an operator surface.

`redactDirectoryIdentifiers` is deliberately NOT applied. That redactor exists
because a directory rejection has a known grammar to match — a UPN, a DN, per
#2843 finding 22. An arbitrary third-party system has none, so a redactor here
would be a pattern list pretending to be a control. The column is encrypted
instead, which does not depend on guessing the format.

## The test that had to be rewritten twice, in opposite directions

The at-rest assertion first read through `prismaTestClient()` and found plaintext,
which looked like the manifest entry being declared and never wired. It was not:
that helper composes `withPiiEncryptionExtension` only — the *Hash columns — not
`withEncryptionExtension`. So the assertion was about the test helper.

Composing the real extension onto a bare client then returned NULL for every
encrypted column, because the DEK is per-tenant and decryption only resolves
inside a tenant context. Which is what `getJournalWrite` is for, and why the
journal now has a read at all.

So there are two reads and they answer different questions: the usecase asserts
CONTENT because it decrypts, `prismaTestClient` asserts STORAGE because it does
not. Both appear, because either alone is satisfied by a bug — content-only passes
if nothing is encrypted, storage-only passes if nothing was written.

## Risk assessment and rollback

STANDARD. A new table, a new enum, one new usecase with no caller yet, and six
registrations. Nothing dispatches: `recordIntent` and `beginWrite` create rows and
send nothing, which is the point — the dispatch that calls them is the next slice,
and it will find the journal already governed rather than have to add it.

Rollback is reverting the commit and dropping the table. Nothing references it, so
no call site breaks.
