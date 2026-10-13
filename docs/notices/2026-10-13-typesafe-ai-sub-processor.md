# Sub-processor notice — TypeSafe AI (Jev)

<!-- docs-accuracy-allow: the doc's whole subject is a notice awaiting issue; removing "not yet" would make it claim it was sent -->
> **STATUS: DRAFTED, NOT YET ISSUED.** Replace `<ISSUE DATE>` below with the date
> this is posted and emailed, and the objection window closes 30 days after it.
> Until then no clock is running. See the end of this file for the two things to
> settle before sending.

**Issued:** `<ISSUE DATE>`
**Objection window closes:** `<ISSUE DATE + 30 days>`

## What is changing

Inflect intends to use **TypeSafe AI** as a sub-processor for one optional
feature: identity adjudication during legacy access recertification.

The feature asks a model to suggest which employee a legacy application account
belongs to, when our deterministic matching cannot decide. A person confirms
every link; the model never writes to your directory and never makes a final
decision.

## Is it on for you?

**No, unless you turn it on.** The setting is per tenant
(`legacyMatchAiMode`), it defaults to **OFF**, and it has three values:

| value | what happens |
| --- | --- |
| `OFF` (default) | no model is asked anything. No data leaves Inflect's infrastructure. |
| `LOCAL_ONLY` | a model we run on our own infrastructure is asked. Nothing goes to TypeSafe AI. |
| `EXTERNAL` | TypeSafe AI is asked. **This notice is about this value only.** |

Turning it off stops every call from the next reconciliation run.

## What would be sent, per account under review

- the legacy account's **username** and its word tokens
- its **display name**, neutralised
- **given and family names**
- the **local part only** of its email address — never the domain
- **department**, **job title**, **account type**
- **transliteration variants** of the names
- for up to five candidate employees: name parts (including middle and preferred
  names) with variants, department and job title

**Excluded by construction** — these are not in the payload at all: email
domains, employee numbers, any dates, employment status, managers,
entitlements, privilege flags, and any column you mapped that is not listed
above.

## Where it is processed

**United States (West Coast).** The transfer relies on Standard Contractual
Clauses. TypeSafe AI holds no EU–US Data Privacy Framework certification, so
the SCCs are the mechanism.

## Retention

Inflect **requires zero retention** of this data by TypeSafe AI: the content of a
request is not to be kept after the response is returned. That requirement is
contractual, and **the data processing agreement carrying it is being executed.**

We have not confirmed it against a countersigned agreement, so we are telling
you what we require rather than what we have verified. When the
agreement is executed we will say so on the public sub-processor list, and the
register entry will stop reading "required" and start reading "confirmed".

If that distinction matters to your own assessment, the feature stays `OFF`
until you decide otherwise — see *Is it on for you?* above.

## Your right to object

You may object on reasonable data-protection grounds within **30 days** of the
issue date above. Write to the contact on your contract or reply to the email
carrying this notice.

If you object, the feature stays `OFF` for your tenant. Objecting costs you
nothing: the default is already off, and the rest of legacy access
recertification works without any model.

## Where to read more

- the full sub-processor register: `docs/sub-processors.md`
- what the feature does and how the payload is built:
  `docs/legacy-access-recertification-design.md`

---

## Before sending — two things, for the issuer only

This section is not part of the customer-facing notice. Delete it before posting.

1. **The DPA — SETTLED 2026-10-13: the sentence was softened rather than the
   agreement executed first.** The Retention section now says the requirement is
   contractual and the agreement is being executed, and states plainly that it
   has not been confirmed against a countersigned copy. That matches the
   register, whose note says the row is "the commitment sought, not a commitment
   verified".

   **What this costs, so nobody is surprised later:** a customer reading this
   knows the retention term is unverified, which is a weaker thing to say than
   the register's row implies on its own. When the DPA is executed, update
   `docs/sub-processors.md` so the row reads *confirmed* rather than *required*,
   and post the follow-up the Retention section promises. Until then the promise
   in this notice is the honest ceiling.

2. **The ordering, and why this is still in time.** The policy requires notice
   at least 30 days before the sub-processor begins processing customer personal
   data. `TYPESAFE_SUBPROCESSOR_ACTIVE` was flipped on 2026-10-11 and an API key
   was installed on the host on 2026-10-13, which looks like activation preceded
   notice. **No customer personal data has reached TypeSafe AI.** Adjudication
   refuses with `NO_EVALUATION` before any provider call unless a committed
   evaluation record exists for the model revision, and
   `src/app-layer/ai/identity-match/evaluations/` is empty — TypeSafe has no
   record, because its thresholds failed the held-out gate (#3462, #3464). So
   processing has not begun and this notice still precedes it. That is worth
   stating if a customer asks why the flag flipped first.
