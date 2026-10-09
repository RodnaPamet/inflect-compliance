# 2026-10-09 — The grant's prior-state pairing, and the shortening case

**Commit:** see the PR for #3300 — `feat(entra): refuse a grant that would shorten existing access`

## The read, and why it is the right one

`read_access_assignments` (#3321), reshaped by #3326. It answers exactly the
question the pairing needs — *what does this subject hold of this package, and
until when* — scoped server-side to the same subject and package the write
targets, which is the property #3300 names as the one a tenant-wide read would
fail:

> A read that returns tenant-wide state technically pairs while capturing
> nothing about the subject — a pairing that cannot express the relevant prior
> state is the "control that cannot fail" shape.

**The pairing can be registered, and that was not a given.** `setPriorStateRead`
rules 3 and 4 read `declaresWrite` off the server's own catalogue:
`declaresWrite(a)` is `a.readOnlyHint !== true`, and the grant endpoint declares
`readOnlyHint: false` on the write and `readOnlyHint: true` on the read. So the
write is a write and the read is a read, by the catalogue's own definition.

## The case this exists for

A grant is not obviously idempotent — the endpoint declares
`idempotentHint: false`. The dangerous shape is not "granting twice is
wasteful", it is:

> the subject already holds the package until the 1st of December, somebody
> grants it until the 1st of November, and if Entra treats `adminAdd` as a
> REPLACE rather than an ADD, a month of access just disappeared.

Nobody asked for that reduction, nothing in the journal looks wrong, and the row
recording it is a successful grant.

**It is refused rather than attempted, and the refusal is correct either way.**
What `adminAdd` actually does to an existing assignment is measurable against a
live tenant and is not measured here — which is the point of refusing instead of
reasoning about it.

## Decisions

- **`live` only, never `all`.** An expired assignment with a later stored end
  date is history, not access — #3326's distinction. Counting one here would
  refuse the grant that is exactly what the subject needs, which is the harmful
  direction. Mutation-proved: swapping `live` for `all` reddens the lapsed-case
  test.

- **Unknown never means shorter.** A holding with no end date is permanent and
  so runs longer than any bounded grant; an end date that will not parse also
  returns true, because *"we could not read when this ends"* is not evidence
  that it ends sooner. Letting the grant through on the strength of a value
  nobody could read would cause exactly the harm the check prevents.

- **Strictly later, not later-or-equal.** An existing assignment ending exactly
  when the new one would is not a shortening, so it is allowed. The refusal
  message says "LATER than the end date requested" to match — an earlier draft
  said "at or beyond", which contradicted the comparison and would have misled
  whoever read it next.

- **Read before write, asserted by call order.** #3300 is explicit that
  *"reading state after a grant is not the same as reading it before"*, so the
  ordering is asserted via `invocationCallOrder` — the only thing that can
  express it.

- **A bad expiry still costs no read.** The expiry refusal runs before the
  connection resolve, and therefore before this read: a grant that must not
  happen does not touch the customer's directory to find that out.

- **This is NOT the paired read `external-write-dispatch` makes.** That one
  captures the before-state into the journal as the audit record, at dispatch
  time. This one answers a question the caller needs answered now. Both exist
  and neither replaces the other.

## Already covered, not duplicated

"A grant without a pairing is refused" needed no new test:
`tests/unit/external-write-dispatch.test.ts` already covers a pairing withdrawn
after approval, and the dispatch refuses with *"The prior-state read pairing was
removed after this was approved."* The deliverable there was the refusal, and it
already exists.

## What remains configuration

Registering the pairing for a real connection is an operator action through
`admin/external-prior-state-read/[connectionId]` — it makes a catalogue round
trip, so it needs a live connection. #3330 turned that from a scripting task
into an operator one by minting the token the endpoint authenticates.
