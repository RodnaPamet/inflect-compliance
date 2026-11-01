/**
 * AGENT OVERSIGHT SETTINGS — five switches an OWNER sets (round 15).
 *
 * Owner decisions of 2026-11-01, on the findings filed while writing the agent
 * pages' help guides:
 *
 *   - #4895: a request composed on `/agents/compose` could be approved by the
 *     person who composed it. Whether it may is now the Owner's choice, and the
 *     default is that it may NOT (`composeNeedsSecondApprover`).
 *   - #4900: an EXACT-VALUE edit to a saved parameter set (no open fields
 *     before or after) could be proposed and approved by one person. A template
 *     edit already needs another person, by trigger. Whether an exact-value
 *     edit does too is the Owner's choice, and the default keeps today's rule
 *     (`exactParameterEditNeedsSecondApprover` off).
 *   - #4896–#4898: Auditors hold the agent inventory view key but were refused
 *     the AI decision log, Agent Receipts and Quarantined proposals. Each of the
 *     three is now an Owner's switch, off by default (today's access).
 *
 * ── WHO A "SECOND PERSON" RULE BINDS ───────────────────────────────────────
 *
 * Only the person the row names: the composer of a composed request, the
 * proposer of a parameter edit. Nobody else's authority changes, and neither
 * rule adds a signature count; the approval itself must come from somebody
 * else.
 *
 * ── WHO THE READ SWITCHES ADMIT ─────────────────────────────────────────────
 *
 * Whoever holds `admin.agent_registry_view` WITHOUT `admin.agent_registry`.
 * For the built-in roles that is the AUDITOR alone; a custom role granting the
 * view key is admitted on the same terms. The register key keeps reading all
 * three regardless, so a switch can only widen who reads, never narrow it.
 * Every gate goes through `mayReadOversightSurface`, so the rule has one
 * definition.
 *
 * ── THIS MODULE IS THE ONLY WRITER ─────────────────────────────────────────
 *
 * The five columns on `TenantSecuritySettings` are written here and nowhere
 * else, by a person holding `admin.tenant_lifecycle`. An API key or an agent
 * cannot change them: the rules govern what agents and their operators may
 * do, so the party they bind must not be able to switch them off.
 */
import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { appendAuditEntry } from '@/lib/audit';
import { forbidden } from '@/lib/errors/types';
import { logger } from '@/lib/observability/logger';
import type { PermissionSet } from '@/lib/permissions';
import { logEvent } from '../events/audit';

export const AGENT_OVERSIGHT_KEYS = [
    'composeNeedsSecondApprover',
    'exactParameterEditNeedsSecondApprover',
    'auditorReadsDecisionLog',
    'auditorReadsReceipts',
    'auditorReadsQuarantine',
] as const;

export type AgentOversightKey = (typeof AGENT_OVERSIGHT_KEYS)[number];
export type AgentOversightSettings = Readonly<Record<AgentOversightKey, boolean>>;

/** The column each key is stored in. */
export const AGENT_OVERSIGHT_COLUMN = {
    composeNeedsSecondApprover: 'agentComposeNeedsSecondApprover',
    exactParameterEditNeedsSecondApprover: 'agentExactParameterEditNeedsSecondApprover',
    auditorReadsDecisionLog: 'auditorReadsAiDecisionLog',
    auditorReadsReceipts: 'auditorReadsAgentReceipts',
    auditorReadsQuarantine: 'auditorReadsAgentQuarantine',
} as const satisfies Record<AgentOversightKey, string>;

/**
 * The value a tenant with no settings row reads. These MUST equal the column
 * defaults in the schema; `tests/unit/agent-oversight-settings.test.ts` reads
 * the schema to hold them together.
 */
export const AGENT_OVERSIGHT_DEFAULTS: AgentOversightSettings = {
    composeNeedsSecondApprover: true,
    exactParameterEditNeedsSecondApprover: false,
    auditorReadsDecisionLog: false,
    auditorReadsReceipts: false,
    auditorReadsQuarantine: false,
};

const SELECT = Object.fromEntries(
    AGENT_OVERSIGHT_KEYS.map((key) => [AGENT_OVERSIGHT_COLUMN[key], true]),
) as Record<(typeof AGENT_OVERSIGHT_COLUMN)[AgentOversightKey], true>;

/** Build the settings from a row (or its absence). Pure; exported for tests. */
export function oversightSettingsFrom(
    row: Readonly<Record<string, unknown>> | null | undefined,
): AgentOversightSettings {
    return Object.fromEntries(
        AGENT_OVERSIGHT_KEYS.map((key) => {
            const stored = row?.[AGENT_OVERSIGHT_COLUMN[key]];
            return [key, typeof stored === 'boolean' ? stored : AGENT_OVERSIGHT_DEFAULTS[key]];
        }),
    ) as AgentOversightSettings;
}

/**
 * The tenant's settings, for a gate to consult. No permission check: every
 * caller is itself a gate, and what it reads is a yes/no about the tenant.
 */
export async function readAgentOversightSettings(ctx: RequestContext): Promise<AgentOversightSettings> {
    const row = await runInTenantContext(ctx, (db) =>
        db.tenantSecuritySettings.findUnique({ where: { tenantId: ctx.tenantId }, select: SELECT }),
    );
    return oversightSettingsFrom(row);
}

function assertOwnerPerson(ctx: RequestContext): void {
    if (!ctx.appPermissions?.admin?.tenant_lifecycle) {
        throw forbidden('Only an owner can view or change the agent oversight settings.', {
            reason: 'AGENT_OVERSIGHT_IS_OWNER_TIER',
        });
    }
    if (ctx.apiKeyId || ctx.agentId) {
        throw forbidden(
            'Agent oversight settings are changed by a person in their own session, never by an API key or an agent.',
            { reason: 'AGENT_OVERSIGHT_NOT_A_PERSON' },
        );
    }
}

/** The settings, for the Owner's admin section. */
export async function getAgentOversightSettings(ctx: RequestContext): Promise<AgentOversightSettings> {
    assertOwnerPerson(ctx);
    return readAgentOversightSettings(ctx);
}

/**
 * Change one or more switches. Only the keys in `patch` move; a key whose value
 * is unchanged is not written and not audited. Returns the settings after the
 * change and the keys that moved.
 */
export async function setAgentOversightSettings(
    ctx: RequestContext,
    patch: Readonly<Partial<Record<AgentOversightKey, boolean>>>,
): Promise<{ settings: AgentOversightSettings; changed: AgentOversightKey[] }> {
    assertOwnerPerson(ctx);

    const outcome = await runInTenantContext(ctx, async (db) => {
        const before = oversightSettingsFrom(
            await db.tenantSecuritySettings.findUnique({ where: { tenantId: ctx.tenantId }, select: SELECT }),
        );
        const changed = AGENT_OVERSIGHT_KEYS.filter(
            (key) => patch[key] !== undefined && patch[key] !== before[key],
        );
        if (changed.length === 0) return { settings: before, changed };

        const columns = Object.fromEntries(
            changed.map((key) => [AGENT_OVERSIGHT_COLUMN[key], patch[key] as boolean]),
        );
        const row = await db.tenantSecuritySettings.upsert({
            where: { tenantId: ctx.tenantId },
            create: { tenantId: ctx.tenantId, ...columns },
            update: columns,
            select: SELECT,
        });

        // One structured field carries the whole change, so the audit row
        // names exactly which switches moved and from what to what, and holds
        // nothing else: the settings are booleans, so no free text can reach
        // the trail through here.
        const switches = Object.fromEntries(
            changed.map((key) => [key, { from: before[key], to: patch[key] as boolean }]),
        );
        await logEvent(db, ctx, {
            action: 'AGENT_OVERSIGHT_SETTINGS_CHANGED',
            entityType: 'Tenant',
            entityId: ctx.tenantId,
            details: 'Agent oversight settings changed',
            detailsJson: {
                category: 'status_change',
                operation: 'update',
                summary: 'Agent oversight settings changed',
            },
            metadata: { switches },
        });

        return { settings: oversightSettingsFrom(row), changed };
    });

    if (outcome.changed.length > 0) {
        logger.info('agent oversight settings changed', {
            component: 'agent-oversight-settings',
            tenantId: ctx.tenantId,
            changed: outcome.changed,
        });
    }
    return outcome;
}

// ── The three read switches ─────────────────────────────────────────────────

export const OVERSIGHT_SURFACES = ['decisions', 'receipts', 'quarantine'] as const;
export type OversightSurface = (typeof OVERSIGHT_SURFACES)[number];

const SURFACE_KEY = {
    decisions: 'auditorReadsDecisionLog',
    receipts: 'auditorReadsReceipts',
    quarantine: 'auditorReadsQuarantine',
} as const satisfies Record<OversightSurface, AgentOversightKey>;

type AdminFlags = Pick<PermissionSet['admin'], 'agent_registry' | 'agent_registry_view'> | null | undefined;

/**
 * The ONE rule for the three surfaces: the register key reads all three; the
 * inventory view key reads a surface only while its switch is on. Pure.
 */
export function mayReadOversightSurfaceWith(
    admin: AdminFlags,
    settings: AgentOversightSettings,
    surface: OversightSurface,
): boolean {
    if (admin?.agent_registry === true) return true;
    return admin?.agent_registry_view === true && settings[SURFACE_KEY[surface]];
}

/** Which of the three the caller may read, for a page and its views menu. */
export async function oversightReadsFor(
    ctx: RequestContext,
): Promise<Readonly<Record<OversightSurface, boolean>>> {
    const admin = ctx.appPermissions?.admin;
    // No settings read for a caller the switches cannot affect.
    const settings =
        admin?.agent_registry === true || admin?.agent_registry_view !== true
            ? AGENT_OVERSIGHT_DEFAULTS
            : await readAgentOversightSettings(ctx);
    return {
        decisions: mayReadOversightSurfaceWith(admin, settings, 'decisions'),
        receipts: mayReadOversightSurfaceWith(admin, settings, 'receipts'),
        quarantine: mayReadOversightSurfaceWith(admin, settings, 'quarantine'),
    };
}

/** May the caller read this surface? */
export async function mayReadOversightSurface(ctx: RequestContext, surface: OversightSurface): Promise<boolean> {
    return (await oversightReadsFor(ctx))[surface];
}

/**
 * Refuse the caller unless they may read this surface, writing a hash-chained
 * `AUTHZ_DENIED` row as `requirePermission` would. For the reads whose gate
 * cannot be a single permission key, because one of its two terms is a tenant
 * setting.
 */
export async function assertMayReadOversightSurface(
    ctx: RequestContext,
    surface: OversightSurface,
): Promise<void> {
    if (await mayReadOversightSurface(ctx, surface)) return;
    await appendAuditEntry({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        actorType: ctx.apiKeyId ? 'API_KEY' : 'USER',
        entity: 'Tenant',
        entityId: ctx.tenantId,
        action: 'AUTHZ_DENIED',
        requestId: ctx.requestId,
        detailsJson: {
            category: 'access',
            event: 'authz_denied',
            reason: 'agent_oversight_surface',
            surface,
        },
    }).catch(() => undefined);
    throw forbidden('You do not have permission to read this.', {
        reason: 'AGENT_OVERSIGHT_SURFACE_NOT_READABLE',
        surface,
    });
}
