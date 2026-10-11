# Sub-processor change policy

How Inflect adds or changes a sub-processor. This codifies the existing
practice as the durable policy. The canonical inventory is
[`docs/sub-processors.md`](./sub-processors.md); the contractual hook is
§7 of the [DPA template](./data-processing-agreement-template.md).

## The four-step process

1. **Engineering proposes the change.** A pull request that edits
   `docs/sub-processors.md` (adding a row + its detail subsection with the
   codebase cross-reference) is the entry point. The PR names the data
   shared, the purpose, the region, and whether it is operator-optional.

2. **Compliance / legal reviews.** Before the sub-processor is wired into
   the product, compliance/legal reviews the data classification, the
   transfer mechanism (SCCs / adequacy / BCRs), and the contractual terms
   (the sub-processor's own DPA). Approval is recorded on the PR.

   **Who that is, concretely:** this repository names no legal or compliance
   function, so the approver of record is the repo owner — see *Sub-processors:
   who confirms which half of step 2* in
   [`docs/change-management-policy.md`](./change-management-policy.md), which
   splits the four confirmations into the two that are clerical and the two
   that need legal competence. An unticked box is not a decision; where a
   transfer impact assessment is not obtained, the decision to proceed without
   one is recorded on this pull request, naming who accepted the risk.

3. **Customers are notified.** Inflect notifies customers at least
   **30 days** before the sub-processor begins processing customer
   personal data. The notification is a one-pager posted to the public
   sub-processor list **and** emailed to each customer's primary contact.
   Customers may object on reasonable data-protection grounds within the
   window.

4. **Activation after the window closes.** The sub-processor is wired into
   the codebase and enabled only after the notification window closes with
   no sustained objection. The `docs/sub-processors.md` entry is the record
   that the steps completed.

## Why this order

The inventory PR comes first so the change is reviewable and the codebase
cross-reference is concrete before any customer-facing notice. The
notification precedes activation so customers exercise their objection
right before — not after — their data reaches a new processor.

## Removing a sub-processor

Removal (decommissioning a service, or disabling an operator-optional one)
follows steps 1–2: an engineering PR removes the row and the wiring, and
compliance confirms no customer data remains with the removed processor.
Customer notification for removal is courtesy, not a 30-day gate.

## Effective date

This policy is effective when this document merges to `main`. The 30-day
customer-notification commitment applies to every sub-processor added
after that date.
