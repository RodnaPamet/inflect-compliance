/**
 * What Entra's answer on a calendar redirect means, read from its error CODE
 * and the AADSTS number in its description — never from the description's
 * text.
 *
 * ═══ WHY ONLY THE CODES ═══
 *
 * `error_description` is Microsoft's prose. It can carry a directory's name, a
 * signed-in person's UPN or a correlation id, so it is never shown, logged,
 * audited or reflected in a redirect. The one thing read out of it is the
 * `AADSTS<digits>` number at its start, which is a fixed vocabulary Microsoft
 * documents and which carries no personal data. Everything downstream sees
 * only the classification and, for the audit row, the bare codes.
 *
 * ═══ UNVERIFIED AGAINST A REAL DIRECTORY ═══
 *
 * The mapping below is built from Microsoft's documentation (the
 * `/adminconsent` endpoint's failure response, the OAuth error codes and the
 * AADSTS error-code reference). It has not been observed against a real Entra
 * directory: the step that built it (#5937 step 3) had no directory to sign in
 * to. `docs/calendar-push-design.md` records it as an open item; when it is
 * observed, narrow this table to what Entra actually sends.
 *
 * @module integrations/providers/calendar/entra-errors
 */

/**
 * What an Entra error on a calendar redirect amounts to.
 *
 *   DECLINED            the person (or administrator) declined, or cancelled
 *   CONSENT_REQUIRED    nobody with the authority has consented for the
 *                       organisation (missing or removed admin consent)
 *   NOT_DIRECTORY_ADMIN the person who signed in to grant organisation-wide
 *                       consent lacks the directory role to grant it
 *   APP_NOT_IN_DIRECTORY the app registration is not available to the
 *                       directory (a single-tenant registration, or one the
 *                       directory has blocked)
 *   OTHER               anything else
 */
export type EntraErrorKind =
    | 'DECLINED'
    | 'CONSENT_REQUIRED'
    | 'NOT_DIRECTORY_ADMIN'
    | 'APP_NOT_IN_DIRECTORY'
    | 'OTHER';

export interface EntraErrorReading {
    kind: EntraErrorKind;
    /** The OAuth `error` value when it is OAuth-shaped, else null. */
    errorCode: string | null;
    /** `AADSTS<digits>` from the start of the description, else null. */
    aadstsCode: string | null;
}

/** OAuth's own vocabulary: lowercase words and underscores. */
const OAUTH_ERROR_SHAPE = /^[a-z_]{1,64}$/;

/**
 * The AADSTS number at the START of the description (Microsoft writes
 * `AADSTS65004: User declined …`). Anchored, and digits only, so nothing else
 * of the description can be lifted out through it.
 */
const AADSTS_AT_START = /^\s*(AADSTS\d{4,7})\b/;

/**
 * AADSTS numbers by meaning, from the AADSTS error-code reference. Only the
 * four whose meaning bears on a remedy are named; any other number falls back
 * to the OAuth `error` value.
 *
 *   65004   UserDeclinedConsent — the person declined
 *   65001   DelegationDoesNotExist — no consent for the app (user or admin)
 *   90094   AdminConsentRequired — the grant needs an administrator
 *   700016  UnauthorizedClient_DoesNotMatchRequest — the app is not found in
 *           the directory (a registration that is not multi-tenant)
 */
const AADSTS_KIND: Readonly<Record<string, EntraErrorKind>> = {
    AADSTS65004: 'DECLINED',
    AADSTS65001: 'CONSENT_REQUIRED',
    AADSTS90094: 'CONSENT_REQUIRED',
    AADSTS700016: 'APP_NOT_IN_DIRECTORY',
};

/**
 * Read Entra's error answer on a redirect. Pure; the description is consulted
 * for its leading AADSTS number only.
 *
 * `flow` decides one difference. On the ADMIN flow, "an administrator's
 * consent is required" (AADSTS90094) means the person who signed in to grant
 * it is not an administrator who can — `NOT_DIRECTORY_ADMIN`. On a person's
 * own sign-in it means the organisation has not (or no longer) granted —
 * `CONSENT_REQUIRED`.
 */
export function readEntraError(
    error: string | null,
    description: string | null,
    flow: 'admin' | 'user',
): EntraErrorReading {
    const errorCode = error && OAUTH_ERROR_SHAPE.test(error) ? error : null;
    const aadstsCode = (description ?? '').match(AADSTS_AT_START)?.[1] ?? null;

    const byNumber = aadstsCode ? AADSTS_KIND[aadstsCode] : undefined;
    let kind: EntraErrorKind;
    if (byNumber) {
        kind = byNumber;
        if (flow === 'admin' && aadstsCode === 'AADSTS90094') kind = 'NOT_DIRECTORY_ADMIN';
    } else if (errorCode === 'consent_required') {
        kind = 'CONSENT_REQUIRED';
    } else if (errorCode === 'access_denied' || errorCode === 'permission_denied') {
        // `permission_denied` is the `/adminconsent` endpoint's documented
        // failure ("The admin canceled the request"); `access_denied` is
        // OAuth's. With no AADSTS number to say otherwise, both are a refusal
        // by the person at the screen.
        kind = 'DECLINED';
    } else if (errorCode === 'unauthorized_client' || errorCode === 'invalid_client') {
        kind = 'APP_NOT_IN_DIRECTORY';
    } else {
        kind = 'OTHER';
    }
    return { kind, errorCode, aadstsCode };
}

/** An Entra directory (tenant) id as `/adminconsent` returns it: a GUID. */
const ENTRA_TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isEntraTenantId(value: string): boolean {
    return ENTRA_TENANT_ID.test(value);
}
