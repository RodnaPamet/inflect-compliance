/**
 * The customer id `changeTenantPlan` writes for a tenant that never went
 * through Stripe checkout. `BillingAccount.stripeCustomerId` is required and
 * unique, so an operator-set plan needs a value, and this one names no Stripe
 * customer. `findOrCreateCustomer` reads it as absent and creates a real
 * customer in its place, or every checkout and portal session for that tenant
 * is refused by Stripe (#5120).
 *
 * A leaf module, so the usecase that mints the id and the Stripe helper that
 * recognises it share one spelling without either importing the other.
 */
export const MANUAL_CUSTOMER_PREFIX = 'manual:';

export function manualCustomerId(tenantId: string): string {
    return `${MANUAL_CUSTOMER_PREFIX}${tenantId}`;
}

export function isManualCustomerId(id: string): boolean {
    return id.startsWith(MANUAL_CUSTOMER_PREFIX);
}
