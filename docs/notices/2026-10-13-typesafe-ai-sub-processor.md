# Sub-processor notice — TypeSafe AI (Jev)

<!-- The filename carries 2026-10-13, the date this was drafted. The
     ISSUE date below is authoritative and is 2026-10-14: the draft was
     finished late on the 13th and an unrelated flaky E2E spec held the
     merge past midnight. Renaming the file would break the register
     link for no gain; a date in a filename is not a claim. -->

**Issued:** 2026-10-14
**Objection window closes:** 2026-11-13

---

> ## WITHDRAWN — 2026-10-14
>
> **This notice is superseded. TypeSafe AI is not a sub-processor and receives no
> data.** It was withdrawn on the same day this notice was issued, so the
> objection window above never ran to its close and no objection can be needed.
>
> Nothing was sent to TypeSafe AI while the path was active: the feature produced
> **zero** adjudications in production. It was withdrawn because it delivered
> nothing measurable while carrying a transfer of personal data to the United
> States, and because the on-premises model that would have avoided that transfer
> did not perform well enough to use.
>
> The notice text is kept below rather than deleted, unchanged. A notice that
> announced a processing activity is a record of what you were told, and editing
> it to match a later decision would remove the only evidence of the
> announcement. Read it as history, not as a description of what happens today.
>
> If you have a question about what was processed in that window, the answer is
> nothing, and `docs/sub-processors.md` carries the measurement behind that.

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

You may object on reasonable data-protection grounds by
**2026-11-13**. Write to **ivo@inflect.bg**, or to the contact on your
contract.

If you object, the feature stays `OFF` for your tenant. Objecting costs you
nothing: the default is already off, and the rest of legacy access
recertification works without any model.

## Where to read more

- the full sub-processor register: `docs/sub-processors.md`
- what the feature does and how the payload is built:
  `docs/legacy-access-recertification-design.md`

---

## How this notice was issued

Recorded here rather than inferred, because the sub-processor register points at
this file as the evidence that step 3 of
`docs/sub-processor-change-policy.md` completed.

- **Posted** to the public sub-processor list on **2026-10-14** — this file,
  on `main`, in a public repository, linked from `docs/sub-processors.md`.
- **Emailed to customers: NOT DONE, because there were none.** The policy's email
  leg protects the objection right of an EXISTING customer whose data is about to
  reach a new processor. On 2026-10-14 the deployment had no live customer
  tenants — the eleven rows in production are the owner's own and test fixtures.
  So no primary contact existed to write to, and the objection window below runs
  against the public list alone. A customer onboarded after this date receives the
  sub-processor list as it then stands, which is the ordinary path and not a
  notice event.

  Stated plainly because "emailed every customer" and "there were no customers"
  are different compliance postures, and only one of them is true.
- **Retention is the one term this notice does not verify.** It says the
  requirement is contractual and the agreement is being executed. When the DPA is
  countersigned, update `docs/sub-processors.md` so the row reads *confirmed*
  rather than *required*, and post the follow-up the Retention section promises.
- **The flag preceded the notice, and no data moved.**
  `TYPESAFE_SUBPROCESSOR_ACTIVE` flipped on 2026-10-11 and an API key was
  installed on 2026-10-13. No customer personal data has reached TypeSafe:
  adjudication refuses with `NO_EVALUATION` before any provider call unless a
  committed evaluation record exists for the model revision, and
  `src/app-layer/ai/identity-match/evaluations/` is empty — TypeSafe has no record
  because its thresholds failed the held-out gate (#3462, #3464). Processing has
  not begun, so this notice precedes it.
