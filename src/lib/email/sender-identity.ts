/**
 * The address this deployment sends as — one definition, two consumers.
 *
 * WHY THIS MODULE EXISTS. The default lived in two places that never agreed:
 * `mailer.ts` used it for the SMTP transport's `from`, and
 * `app-layer/notifications/settings.ts` used its own copy as the fallback for a
 * tenant with no `TenantNotificationSettings` row. `processOutbox` overrides
 * `from` per tenant from the second one, so the transport default was never
 * reached for outbox mail and only the second copy mattered.
 *
 * Both copies read `noreply@inflect.app`. That address is deliverable only from
 * a deployment whose relay has verified `inflect.app`; production's had
 * verified `inflect.bg` and had `SMTP_FROM` set to it correctly the whole time.
 * The relay answered every message:
 *
 *     550 The inflect.app domain is not verified.
 *
 * 520 failures across digests, policy-approval requests and identity-leaver
 * alerts, last successful send 2026-06-03, on a correctly-configured
 * deployment. Two defaults, one of them right, and the wrong one won — so the
 * fix is not to correct both literals but to leave only one thing to correct.
 *
 * WHY `process.env` AND NOT `@/env`. Same reason `mailer.ts` gives, and it is
 * the same failure class: a bundled route-handler chunk can carry an `@/env`
 * copy whose server-only vars are not surfaced, so `env.SMTP_FROM` reads
 * undefined and the caller silently falls back. `process.env` is populated
 * identically in every chunk. (`SMTP_FROM` is registered in `env.ts`.)
 *
 * WHY A FUNCTION AND NOT A CONST. Resolved per call. The worker imports
 * `settings.ts` before `initMailerFromEnv` runs, and a module-load constant
 * would make the value depend on import order between two modules that
 * otherwise have none. It also lets tests set the variable without juggling
 * the module registry.
 *
 * NO IMPORTS, DELIBERATELY. `settings.ts` is reached from the
 * notification-settings route and today pulls in nothing at runtime; importing
 * `mailer.ts` for this would drag nodemailer into that bundle.
 */

/**
 * The literal used when a deployment has configured no sender at all.
 *
 * It is a placeholder, not a working address — any deployment that actually
 * delivers mail sets `SMTP_FROM` to a domain its relay has verified.
 */
export const UNCONFIGURED_SENDER = 'noreply@inflect.app';

/** The address this deployment sends as. */
export function deploymentSenderAddress(): string {
    return process.env.SMTP_FROM || UNCONFIGURED_SENDER;
}
