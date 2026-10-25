/**
 * Absolute links for email bodies (#4130).
 *
 * An email is opened in a mail client, not in the app, so a relative href such
 * as `/t/acme/tasks` resolves against nothing and the button does not open the
 * page. The notification templates built exactly those, and nothing made them
 * absolute before sending (`processOutbox` and the mailer pass the body
 * through). The vendor-assessment emails were the only ones that worked,
 * because their callers prefix `APP_URL` themselves.
 *
 * `APP_URL` is the source: the operator's statement of where this deployment
 * lives (`src/env.ts`), the one `publicBaseUrl` treats as authoritative and the
 * vendor-assessment links already use. Every template that links into the app
 * goes through this helper, so there is one place that knows how.
 *
 * With `APP_URL` unset the path is returned unchanged — the behaviour the
 * vendor-assessment reminder already has — because a deployment without one
 * has no public origin to name, and inventing `localhost` would send a
 * customer a link to their own machine. Production sets it.
 */
import { env } from '@/env';

/** `path` (starting with `/`) made absolute against `APP_URL`, when it is set. */
export function appLink(path: string): string {
    const origin = (env.APP_URL ?? '').trim().replace(/\/+$/, '');
    return `${origin}${path}`;
}
