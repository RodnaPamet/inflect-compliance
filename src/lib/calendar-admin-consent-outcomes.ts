/**
 * Where the Microsoft admin-consent callback sends the administrator back, as
 * `?calendar=<outcome>` on `/t/<slug>/admin/integrations` (#5937 step 3).
 *
 * A closed set, so the consent card can word each one and nothing else reaches
 * the URL — Entra's own error code or description is never reflected. Its own
 * module, with no imports, because both the server (the callback and its
 * usecase) and the client (the card) read it, and the usecase module is
 * server-only.
 */
export const CALENDAR_ADMIN_CONSENT_OUTCOMES = [
    /** Entra answered `admin_consent=True`, and the grant is recorded. */
    'consent_granted',
    /** The administrator declined or cancelled at Entra. */
    'consent_declined',
    /** The account that signed in at Entra cannot grant organisation-wide consent. */
    'not_directory_admin',
    /** The app registration is not available to the administrator's directory. */
    'app_not_in_directory',
    /** Any other answer from Entra, or one that names no directory we can use. */
    'provider_error',
    /** The flow cookie was absent, forged, expired, for another state, or another person's. */
    'flow_invalid',
    /** The person who returned no longer holds the workspace permission to grant. */
    'not_permitted',
    /** No workspace context (signed out, not a member), or the grant could not be recorded. */
    'consent_failed',
] as const;
export type CalendarAdminConsentOutcome = (typeof CALENDAR_ADMIN_CONSENT_OUTCOMES)[number];

export function isCalendarAdminConsentOutcome(value: string | null | undefined): value is CalendarAdminConsentOutcome {
    return (CALENDAR_ADMIN_CONSENT_OUTCOMES as readonly string[]).includes(value ?? '');
}
