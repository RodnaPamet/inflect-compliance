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
| `src/lib/stripe.ts` | `idOf`, `invoiceSubscriptionId`, `recordBillingEvent`, `applySubscriptionEvent` (the stored-subscription check); every branch goes through it |
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
- **The stored-subscription check reads the row once, before the re-fetch.**
  It is not part of the write's `WHERE`. A checkout for a new subscription
  committing between that read and an old event's write can still be
  overwritten; the window is one Stripe round trip. Closing it needs a
  conditional update and was not part of the decision.
- **A null stored id applies any subscription's live state, as decided.** An
  ended subscription is applied as the deletion write (CANCELED, FREE). For an
  account that never subscribed, or whose subscription was already deleted,
  that is harmless for entitlements, which read the plan alone. It is not
  harmless for an account whose plan an operator set with `changeTenantPlan`
  after its subscription ended: that usecase writes the plan and leaves
  `stripeSubscriptionId` null, so a late event about the old subscription
  resets the operator's plan to FREE. Reported for an owner decision, not
  changed here.
