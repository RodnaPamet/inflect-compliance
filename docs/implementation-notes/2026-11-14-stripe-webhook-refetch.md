# 2026-11-14 — Stripe webhook re-fetches the live subscription

**Issue:** #5316 item 28 (owner decision 2026-11-14)

## Design

The Stripe webhook applied the subscription embedded in each event with no
ordering check. Stripe delivers events out of order and re-delivers late ones,
so an older event could overwrite newer billing state:

1. Checkout completes. `checkout.session.completed` re-fetched the live
   subscription and stored ACTIVE. The earlier `customer.subscription.created`
   (status `incomplete`) arrived next and set INCOMPLETE.
2. A delayed `customer.subscription.updated` arrived after
   `customer.subscription.deleted`. It wrote `stripeSubscriptionId` back and
   set ACTIVE on a cancelled subscription.

Every subscription branch now does what the checkout branch already did. The
event names the subscription, `applyLiveSubscription` re-fetches it with the
same lazily built client (`getStripe().subscriptions.retrieve`), and the live
answer is written. The order events arrive in decides nothing.

```
event ──► signature check (route, unchanged)
      ──► BillingEvent idempotency skip (unchanged)
      ──► billing account lookup by customer
      ──► retrieve live subscription
             ├─ resource_missing / canceled / incomplete_expired ─► deletion write
             ├─ any other status ─► live-state write
             └─ any other error ─► SubscriptionRefetchError, nothing written
      ──► BillingEvent row
```

## Files

| File | Role |
|---|---|
| `src/lib/stripe.ts` | `retrieveLiveSubscription`, `applyLiveSubscription`, `SubscriptionRefetchError`; checkout and the three subscription branches call the one helper |
| `src/app/api/stripe/webhook/route.ts` | answers 503 on `SubscriptionRefetchError` so Stripe retries |
| `tests/unit/lib/stripe.test.ts` | ordered event sequences against a stateful fake row and a mocked live retrieve |
| `tests/unit/stripe-webhook-route-refetch.test.ts` | the real route over the real handler: 503 on a failed re-fetch, 200 otherwise |
| `docs/billing.md` | "How the webhook applies a subscription event" |

## Decisions

- **The deletion write is unchanged.** An ended live status, or
  `resource_missing`, writes exactly what `customer.subscription.deleted`
  wrote before: CANCELED, FREE, `stripeSubscriptionId = null`. No migration
  and no new column.
- **Only a failed re-fetch turns into a non-2xx.** The route still answered
  200 on every processing error, so a failed re-fetch would have been
  dropped and never retried. It now answers 503 for `SubscriptionRefetchError`
  alone. Every other processing error keeps the existing 200, because changing
  that is a separate decision.
- **A failed re-fetch records no `BillingEvent`.** The idempotency row is
  written after the account write, so Stripe's re-delivery is not skipped.
- **`resource_missing` is read off the error's `code`.** That is the field
  Stripe's SDK sets on `StripeInvalidRequestError`. Any other error, Stripe's
  or not, is a refetch failure.
- **The invoice branches are not changed.** `invoice.payment_failed` and
  `invoice.payment_succeeded` write a status from the event type, not from a
  snapshot. A late `payment_failed` can still set PAST_DUE on a cancelled
  account. Re-fetching them depends on where the invoice names its
  subscription, which differs between Stripe API versions. That is left open.
- **Events about another subscription are not filtered.** The account holds
  one `stripeSubscriptionId`. A late event about an older, replaced
  subscription still applies that subscription's live state, including the
  deletion write, over the current one. This was also true before the change
  and is left open.
