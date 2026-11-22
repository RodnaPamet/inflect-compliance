# 2026-11-14 — Stripe webhook follow-ups: retries, stored subscription, invoices

**Issue:** #5316 item 28, follow-ups (three owner decisions, 2026-11-14).
Builds on `2026-11-14-stripe-webhook-refetch.md`.

## Design

Three changes to the webhook, each closing a case the re-fetch left open.

1. **Every processing error after the signature check is retried.** The
   route answered 200 to every processing error except a failed re-fetch, so
   Stripe treated the event as delivered and the change was lost. It now
   answers 500, keeping 503 for `SubscriptionRefetchError` and 400 for a
   signature failure.
2. **A subscription event is applied only when it is about the stored
   subscription.** `BillingAccount` holds one `stripeSubscriptionId`. A
   `customer.subscription.*` or invoice event whose subscription differs from
   a non-null stored id is recorded as processed and changes nothing.
   `checkout.session.completed` is exempt: it is what sets a new subscription.
3. **The invoice branches re-fetch.** `invoice.payment_failed` and
   `invoice.payment_succeeded` wrote PAST_DUE / ACTIVE by event type, so a late
   `payment_failed` set PAST_DUE on a cancelled account. They now read the
   subscription the invoice names and apply its live state through the same
   path as the subscription events, rule 2 included.

```
event ──► signature (route) ─── fails ─► 400
      ──► BillingEvent idempotency skip
      ──► which subscription?  checkout: session.subscription
                               subscription.*: the object's id
                               invoice.*: parent.subscription_details.subscription
                                          or invoice.subscription; none ─► no change
      ──► billing account by customer (none ─► no change)
      ──► stored id set and different, not checkout ─► record, log, no change
      ──► re-fetch and apply live state (applyLiveSubscription)
      ──► BillingEvent row
any throw ─► route: 503 (re-fetch) or 500 (anything else), nothing recorded
```

## Files

| File | Role |
|---|---|
| `src/lib/stripe.ts` | `idOf`, `invoiceSubscriptionId`, `recordBillingEvent`, `applySubscriptionEvent` (the stored-subscription check), `applyLiveSubscription`'s `WriteCondition` and outcomes; every branch goes through it |
| `src/app/api/stripe/webhook/route.ts` | 500 on any processing error; logs event id, type, error class and code |
| `tests/unit/lib/stripe.test.ts` | non-current subscription ignored, checkout exempt, invoice shapes, late invoice on a cancelled account, invoice with no subscription |
| `tests/unit/stripe-webhook-route-refetch.test.ts` | 500 on a write, record or idempotency-read failure; no `BillingEvent` on failure; log fields; 400 kept |
| `docs/billing.md` | "How the webhook applies a subscription event" |

## Decisions

- **The idempotency row was already written last.** Every branch writes the
  account, then the `BillingEvent`, so a failed write leaves nothing recorded
  and the re-delivery is processed. No transaction was added. A failure of
  the `BillingEvent` insert after a successful account write answers 500 and
  the re-delivery re-applies the live state, which is idempotent.
- **The error message is not logged.** A Prisma error's message quotes the
  arguments of the failed query. The log carries the event id and type, the
  error's class name and its `code`.
- **Both invoice fields are read through `unknown`.** Stripe SDK 23.1.0
  (API version `2026-10-28.endive`, the SDK default; the repo pins no
  `apiVersion`) types only `invoice.parent.subscription_details.subscription`.
  A webhook endpoint configured on an older API version sends
  `invoice.subscription`. Both are narrowed with type guards; no `as any`.

## Second round (owner decisions, 2026-11-14)

The first commit reported two open cases; the owner decided both.

4. **No stored subscription: an ended subscription changes nothing.**
   `changeTenantPlan` writes the plan and leaves `stripeSubscriptionId` null,
   so after a subscription ended and an operator set a plan, a late event
   about the old subscription re-fetched it as cancelled and reset the plan
   to FREE. A never-subscribed FREE/ACTIVE account was also moved to
   CANCELED. Now, when the stored id is null and the live subscription has
   ended (`canceled`, `incomplete_expired`, `resource_missing`), nothing is
   written, one info line is logged and the event is recorded. A live state
   that has not ended is still applied to a null stored id.
5. **The write is conditional on the stored id it read.** Every event but a
   checkout writes with `updateMany` whose `WHERE` names the
   `stripeSubscriptionId` read before the Stripe round trip, null included.
   A checkout committing a new subscription in that window makes the old
   event's write match no row; one info line is logged.

```
read account (stored id S) ──► re-fetch ──► ended and S is null ─► no write
                                        └─► updateMany WHERE stripeSubscriptionId = S
                                              count 0 ─► superseded, no write
record BillingEvent in every outcome above
```

- **A superseded event is recorded.** The account already holds state another
  event for this customer wrote after the read. A re-delivery would read that
  newer state and be ignored as non-current, or hit the null-and-ended rule, or
  apply the same live answer the other event applied. Answering non-2xx would
  buy a retry that changes nothing.
- **A completed checkout stays unconditional.** It sets a new subscription
  over whatever is stored. Conditioning it on the id it read would let the old
  subscription's deletion, committing during the checkout's re-fetch, make the
  checkout's write miss and leave a paying tenant on FREE with no
  subscription. Unconditional, the checkout lands last or the deletion's own
  conditional write misses the new id.
- **A checkout of a subscription that has since ended still writes the
  deletion.** It is unaffected by the null-stored rule, as decided.
