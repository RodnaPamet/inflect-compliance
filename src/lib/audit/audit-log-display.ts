/**
 * How the Audit log page shows a stored entry (#4468).
 *
 * An `AuditLog` row stores codes, not prose: `action` is a SNAKE_CASE verb
 * (`CUSTOM_ROLE_CREATED`), `entity` is whatever each writer passed — mostly a
 * Prisma model name (`TenantCustomRole`), sometimes upper case (`RISK`) — and
 * `details` is the writer's sentence with `logEvent`'s request reference
 * appended (`…\n\nContext: {"requestId":"…"}`), or that reference alone for
 * an entry whose sentence is in `detailsJson.summary`.
 *
 * Pure and client-safe. The dashboard's feed has its own phrasing layer
 * (`./activity-humanize`); this one is for a table column, and borrows only
 * that layer's entity map.
 */
import { activityEntityMeta } from './activity-humanize';

/** Words a readable code keeps in capitals. */
const ACRONYMS = new Set([
    'A2A', 'AI', 'API', 'AV', 'BIA', 'CSV', 'CVE', 'DEK', 'DPA', 'DPIA', 'DSAR',
    'HRIS', 'ID', 'IP', 'ISO', 'JML', 'KEK', 'KPI', 'KRI', 'MCP', 'MFA', 'NIS2',
    'OIDC', 'PDF', 'SAML', 'SCIM', 'SIEM', 'SLA', 'SOA', 'SOC', 'SSO', 'URL',
]);

/** Abbreviations a reader would not recognise, spelled out. */
const SPELLED_OUT: Record<string, string> = {
    AUTHN: 'authentication',
    AUTHZ: 'authorization',
};

/**
 * A stored code as words, sentence case: `CUSTOM_ROLE_CREATED` → "Custom role
 * created", `TenantCustomRole` → "Tenant custom role", `AUTHZ_DENIED` →
 * "Authorization denied". Known acronyms stay in capitals. A code with no
 * letters or digits comes back unchanged.
 */
export function readableAuditCode(code: string): string {
    const words = code
        .trim()
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .split(/[\s_.:/-]+/)
        .filter((w) => w !== '');
    if (words.length === 0) return code;
    return words
        .map((word, i) => {
            const upper = word.toUpperCase();
            if (ACRONYMS.has(upper)) return upper;
            const lower = SPELLED_OUT[upper] ?? word.toLowerCase();
            return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
        })
        .join(' ');
}

/**
 * The i18n key, under `dashboard.activity.entity`, for an entity type that has
 * a translated noun, or `null` for the long tail (shown via
 * `readableAuditCode`).
 */
export function auditEntityNounKey(entity: string): string | null {
    return activityEntityMeta(entity)?.nounKey ?? null;
}

const CONTEXT_MARKER = 'Context: ';

/**
 * `details` without the request reference `logEvent` appends to it. Removed
 * only when it is exactly that: the marker at the start of the text or after
 * a blank line, followed by a JSON object running to the end. Anything else is
 * the writer's own text and is kept.
 */
export function withoutRequestContext(details: string): string {
    let from = 0;
    for (;;) {
        const at = details.indexOf(`${CONTEXT_MARKER}{`, from);
        if (at === -1) return details;
        if (at === 0 || details.slice(0, at).endsWith('\n\n')) {
            try {
                const parsed: unknown = JSON.parse(details.slice(at + CONTEXT_MARKER.length));
                if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    return details.slice(0, at).replace(/\n\n$/, '');
                }
            } catch {
                // Not the appended reference — keep looking.
            }
        }
        from = at + 1;
    }
}

/**
 * The Details column: the writer's sentence without the request reference,
 * or, for an entry that has none, its `detailsJson.summary`. `null` when the
 * entry carries neither.
 */
export function auditLogDetailsText(details: string | null, detailsJson: unknown): string | null {
    const sentence = details === null ? '' : withoutRequestContext(details).trim();
    if (sentence !== '') return sentence;
    if (detailsJson !== null && typeof detailsJson === 'object' && !Array.isArray(detailsJson)) {
        const summary = (detailsJson as Record<string, unknown>).summary;
        if (typeof summary === 'string' && summary.trim() !== '') return summary.trim();
    }
    return null;
}
