/**
 * Why a vendor questionnaire was not sent (#4696).
 *
 * `sendAssessment` names each refusal in `error.details.reason`, beside an
 * English `error.message`. The vendor page maps a known reason to its own
 * translated sentence (`vendors.detail.sendRefused.<reason>`) and falls back
 * to the server's message for anything else. One of those messages told the
 * user to "Pass force=true", which no screen offers.
 *
 * Client-safe: no server imports.
 */

export const VENDOR_SEND_REFUSALS = [
    'SEND_RESPONDENT_EMAIL_INVALID',
    'SEND_TEMPLATE_DRAFT',
    'SEND_ALREADY_IN_FLIGHT',
] as const;

export type VendorSendRefusal = (typeof VENDOR_SEND_REFUSALS)[number];

const KNOWN: ReadonlySet<string> = new Set<string>(VENDOR_SEND_REFUSALS);

/** The named reason in a parsed API error body, or null when it names none of these. */
export function vendorSendRefusal(body: unknown): VendorSendRefusal | null {
    const reason = (body as { error?: { details?: { reason?: unknown } } } | null)?.error
        ?.details?.reason;
    return typeof reason === 'string' && KNOWN.has(reason) ? (reason as VendorSendRefusal) : null;
}
