/**
 * Recent-activity humanisation — the pure, i18n-key-producing layer
 * behind the dashboard's Recent Activity feed.
 *
 * Audit rows store `action` (a `SNAKE_CASE` verb string like
 * `RISK_CREATED` / `CONTROL_STATUS_CHANGED`) and `entity` (a raw
 * entity-type string written by each `logEvent` caller with
 * inconsistent casing — `'Risk'`, `'RISK'`, …). The feed used to
 * render these as `action.toLowerCase() + ' ' + entity.toLowerCase()`
 * — a raw-enum leak. This module turns them into:
 *
 *   • a localized VERB   — via `activityVerbToken()` → the i18n key
 *     `dashboard.activity.verb.<TOKEN>` for the common verbs, with a
 *     de-snaked readable fallback for the long tail.
 *   • a localized NOUN   — via `activityEntityMeta()` → the i18n key
 *     `dashboard.activity.entity.<nounKey>`.
 *   • a link to the item — `path(entityId)` when the entity has a
 *     navigable surface, else `null` (rendered as plain text).
 *
 * Pure + client-safe (no server-only imports) so the server
 * `RecentActivityCard` and any future client feed both consume it.
 */

/** Collapse the raw `entity` string to a canonical UPPERCASE key. */
export function normalizeActivityEntity(entity: string): string {
    return entity.trim().toUpperCase();
}

/** `RISK_STATUS_CHANGED` → `risk status changed` (graceful fallback). */
export function humanizeSnakeCase(value: string): string {
    return value
        .trim()
        .replace(/_+/g, ' ')
        .toLowerCase()
        .trim();
}

export interface ActivityEntityMeta {
    /** i18n key under `dashboard.activity.entity`. */
    nounKey: string;
    /**
     * Builder for the tenant-RELATIVE path to the changed item (the
     * caller prefixes `/t/<slug>`), or `null` when the entity has no
     * per-item navigable surface (rendered as plain text).
     */
    path: ((entityId: string) => string) | null;
}

/**
 * Entity-type → noun + link surface. Only entities with a real
 * navigable surface carry a `path`; `evidence` links to its detail
 * SHEET (`?ev=`) since it has no `[id]` route, and `finding` has no
 * per-item surface at all (`path: null`).
 */
export const ACTIVITY_ENTITY_META: Record<string, ActivityEntityMeta> = {
    RISK: { nounKey: 'risk', path: (id) => `/risks/${id}` },
    CONTROL: { nounKey: 'control', path: (id) => `/controls/${id}` },
    POLICY: { nounKey: 'policy', path: (id) => `/policies/${id}` },
    EVIDENCE: { nounKey: 'evidence', path: (id) => `/evidence?ev=${id}` },
    TASK: { nounKey: 'task', path: (id) => `/tasks/${id}` },
    FINDING: { nounKey: 'finding', path: null },
    VENDOR: { nounKey: 'vendor', path: (id) => `/vendors/${id}` },
    ASSET: { nounKey: 'asset', path: (id) => `/assets/${id}` },
    INCIDENT: { nounKey: 'incident', path: (id) => `/incidents/${id}` },
    ISSUE: { nounKey: 'issue', path: (id) => `/issues/${id}` },
};

/** Metadata for a raw `entity` string, or `null` for unknown types. */
export function activityEntityMeta(entity: string): ActivityEntityMeta | null {
    return ACTIVITY_ENTITY_META[normalizeActivityEntity(entity)] ?? null;
}

/**
 * The common audit verbs we localize. A trailing token here resolves
 * to the i18n key `dashboard.activity.verb.<TOKEN>`; anything else
 * degrades to the de-snaked fallback. `STATUS_CHANGED` is a two-word
 * suffix (`*_STATUS_CHANGED`) matched before the single trailing
 * token so it reads "changed the status of", not "changed".
 */
export const KNOWN_ACTIVITY_VERBS = [
    'CREATED', 'UPDATED', 'DELETED', 'APPROVED', 'REJECTED', 'CLOSED',
    'LINKED', 'UNLINKED', 'UPLOADED', 'SUBMITTED', 'ARCHIVED', 'COMPLETED',
    'ASSIGNED', 'REVOKED', 'PUBLISHED', 'REQUESTED', 'ACKNOWLEDGED',
    'RESOLVED', 'REOPENED', 'CANCELED', 'EXPIRED', 'RENEWED', 'GENERATED',
    'IMPORTED', 'EXPORTED', 'REMOVED', 'ADDED', 'REVIEWED', 'SHARED',
    'STATUS_CHANGED',
] as const;

const KNOWN_VERB_SET = new Set<string>(KNOWN_ACTIVITY_VERBS);

export interface ActivityVerb {
    /** i18n token (`dashboard.activity.verb.<token>`), or null. */
    token: string | null;
    /** De-snaked readable fallback (used when `token` is null). */
    fallback: string;
}

/**
 * The generic CRUD actions many `logEvent` callers write as a bare verb
 * (`UPDATE`, not `RISK_UPDATED`), mapped onto the verb tokens above.
 */
const GENERIC_VERB_ALIASES: Readonly<Record<string, (typeof KNOWN_ACTIVITY_VERBS)[number]>> = {
    CREATE: 'CREATED',
    UPDATE: 'UPDATED',
    DELETE: 'DELETED',
    SOFT_DELETE: 'DELETED',
    STATUS_CHANGE: 'STATUS_CHANGED',
};

/**
 * Whole-action events that are a sentence on their own — an actor and what
 * they did, with no entity noun ("signed in"). Their `entity` (`'Auth'`,
 * `'User'`) is bookkeeping, not an object worth naming, and their trailing
 * word (`SUCCESS`, `FAILURE`) is no verb. Each resolves to
 * `dashboard.activity.event.<ACTION>` for the feed and
 * `admin.auditActionChip.event.<ACTION>` for the audit log's action chip.
 */
export const ACTIVITY_EVENT_ACTIONS = [
    'AUTH_LOGIN_SUCCESS',
    'AUTH_LOGIN_FAILURE',
    'AUTH_LOGIN_RATE_LIMITED',
    'AUTH_PASSWORD_CHANGED',
    'AUTH_PASSWORD_RESET_REQUESTED',
    'AUTH_PASSWORD_RESET_COMPLETED',
    'AUTH_EMAIL_VERIFIED',
    'MFA_ENROLLED',
    'MFA_REMOVED',
    'MFA_CHALLENGE_PASSED',
    'MFA_CHALLENGE_FAILED',
    'AUTHZ_DENIED',
    'TENANT_SEEDED',
] as const;

const EVENT_ACTION_SET = new Set<string>(ACTIVITY_EVENT_ACTIONS);

/**
 * The noun key of the entity an action NAMES, for a verb-token action:
 * `RISK_CREATED` → `'risk'`. `bare` is true for the generic bare verbs
 * (`UPDATE`), which name no entity — the caller falls back to the row's own
 * `entity`. `nounKey` is null when the prefix is not a known entity
 * (`CONTROL_EVIDENCE_LINKED`) or the action has no verb token at all.
 */
export function activitySubject(action: string): { nounKey: string | null; bare: boolean } {
    const upper = normalizeActivityEntity(action);
    if (GENERIC_VERB_ALIASES[upper]) return { nounKey: null, bare: true };
    const { token } = activityVerbToken(action);
    if (!token || upper.length <= token.length + 1) return { nounKey: null, bare: false };
    const prefix = upper.slice(0, upper.length - token.length - 1);
    return { nounKey: activityEntityMeta(prefix)?.nounKey ?? null, bare: false };
}

/** The whole-action event token for `action`, or null when it is not one. */
export function activityEventToken(action: string): string | null {
    const upper = normalizeActivityEntity(action);
    return EVENT_ACTION_SET.has(upper) ? upper : null;
}

/**
 * Resolve an audit `action` to a localizable verb token. Matches the
 * generic bare verbs first, then the `*_STATUS_CHANGED` two-word suffix,
 * then the single trailing `_TOKEN`. Unknown actions return `token: null`
 * + a de-snaked fallback of the whole action.
 */
export function activityVerbToken(action: string): ActivityVerb {
    const upper = normalizeActivityEntity(action);
    const fallback = humanizeSnakeCase(action);
    const alias = GENERIC_VERB_ALIASES[upper];
    if (alias) return { token: alias, fallback };
    if (upper.endsWith('STATUS_CHANGED')) {
        return { token: 'STATUS_CHANGED', fallback };
    }
    const parts = upper.split('_');
    const last = parts[parts.length - 1];
    if (KNOWN_VERB_SET.has(last)) {
        return { token: last, fallback };
    }
    return { token: null, fallback };
}
