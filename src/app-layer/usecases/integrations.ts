/**
 * Integration Framework — App-Layer Usecases
 *
 * Tenant-scoped operations for managing integration connections,
 * executing automation checks, and handling webhook events.
 *
 * All mutations require appropriate RBAC permissions.
 * All reads are scoped to the calling tenant.
 *
 * @module usecases/integrations
 */
import { Prisma, EvidenceType } from '@prisma/client';
import type { RequestContext } from '../types';
import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
// Side-effect: register every provider into the registry IN THIS MODULE GRAPH.
// The registry is a module singleton; relying on `instrumentation.ts` to
// populate it does NOT work when Next bundles instrumentation and the route
// handler into different module instances (the dropdown then renders empty and
// automation-runner/identity-sync resolve no provider). Importing bootstrap
// here guarantees the registry is populated wherever these usecases load.
import '../integrations/bootstrap';
import { registry } from '../integrations/registry';
import { isScheduledCheckProvider } from '../integrations/types';
import type { CheckResult, EvidencePayload } from '../integrations/types';
import { encryptField, decryptField } from '@/lib/security/encryption';
import { logEvent } from '../events/audit';
import { notFound, badRequest, forbidden } from '@/lib/errors/types';
import { validateProviderConfig } from '../integrations/config-schema';
import { LEAVER_PASS_AUTOMATION_SUFFIX } from './identity-leaver-pass';
import { logger } from '@/lib/observability/logger';
import { CONNECTION_STALE_AFTER_SECONDS } from '@/lib/observability/connection-freshness';
import { runIdentitySync } from './identity-sync';
import { IDENTITY_ROSTER_PAGE_SIZE } from '@/lib/identity-roster';

/** Providers whose connection-level sync runs a directory/account sync. */
const IDENTITY_SYNC_PROVIDERS = new Set(['okta', 'google-workspace', 'entra-id', 'active-directory']);

// ─── Connection Management ───────────────────────────────────────────

/**
 * List all integration connections for the tenant.
 * Secrets are never returned — only metadata.
 */
/**
 * Config toggles that WEAKEN a security control, surfaced into the audit entry.
 *
 * Integration config changes were already audited, but the entry recorded only
 * "Updated integration: <name>" — so switching OFF TLS certificate
 * verification against a directory service produced a record indistinguishable
 * from renaming the connection. For a flag that is switched on during setup
 * and never switched back, "something changed" is not a usable record: the
 * question an auditor asks is *when did verification stop*, and the trail could
 * not answer it.
 *
 * Listed explicitly rather than pattern-matched. A new weakening flag should
 * have to be added here by someone who thought about it, the same reason
 * `liveValidation` is required rather than inferred.
 */
const SECURITY_WEAKENING_FLAGS = ['allowSelfSignedTls', 'insecureSkipVerify', 'disableCertValidation'] as const;

/** The weakening flags currently ON, for the audit entry. Empty when none. */
function enabledSecurityFlags(configJson: unknown): string[] {
    if (!configJson || typeof configJson !== 'object') return [];
    const cfg = configJson as Record<string, unknown>;
    return SECURITY_WEAKENING_FLAGS.filter((k) => cfg[k] === true || cfg[k] === 'true');
}

export async function listIntegrationConnections(ctx: RequestContext) {
    return runInTenantContext(ctx, (db) =>
        db.integrationConnection.findMany({
            where: { tenantId: ctx.tenantId },
            select: {
                id: true,
                provider: true,
                name: true,
                isEnabled: true,
                configJson: true,
                lastTestedAt: true,
                lastTestStatus: true,
                // H1-3 — credential health as observed by BACKGROUND syncs.
                // Distinct from lastTest*, which is the operator's Test button.
                authFailedAt: true,
                authFailureReason: true,
                createdAt: true,
                updatedAt: true,
                _count: { select: { executions: true } },
            },
            orderBy: { createdAt: 'desc' },
        })
    );
}

/**
 * Get a single connection by ID (tenant-scoped, no secrets).
 */
export async function getIntegrationConnection(ctx: RequestContext, connectionId: string) {
    return runInTenantContext(ctx, async (db) => {
        const conn = await db.integrationConnection.findFirst({
            where: { id: connectionId, tenantId: ctx.tenantId },
            select: {
                id: true,
                provider: true,
                name: true,
                isEnabled: true,
                configJson: true,
                lastTestedAt: true,
                lastTestStatus: true,
                // H1-3 — credential health as observed by BACKGROUND syncs.
                // Distinct from lastTest*, which is the operator's Test button.
                authFailedAt: true,
                authFailureReason: true,
                createdAt: true,
                updatedAt: true,
            },
        });
        if (!conn) throw notFound('Integration connection not found');
        return conn;
    });
}

/**
 * Create or update an integration connection.
 * Secrets are encrypted before storage.
 */
export async function upsertIntegrationConnection(
    ctx: RequestContext,
    input: {
        id?: string;
        provider: string;
        name: string;
        configJson?: Record<string, unknown>;
        secrets?: Record<string, unknown>;
        isEnabled?: boolean;
    }
) {
    if (!ctx.permissions?.canAdmin) throw forbidden('Admin only');

    // Validate provider is registered
    const providerImpl = registry.getProvider(input.provider);
    if (!providerImpl) throw badRequest(`Unknown provider: ${input.provider}`);

    // Encrypt secrets if provided
    let secretEncrypted: string | undefined;
    if (input.secrets && Object.keys(input.secrets).length > 0) {
        secretEncrypted = encryptField(JSON.stringify(input.secrets));
    }

    // Validate BEFORE anything is written. configJson was previously stored
    // verbatim, which is how a tenant-admin string reached a token POST carrying
    // client credentials (Workday), four credentialed calls (Okta) and an LDAPS
    // bind target (Active Directory). Each was fixed at its call site; this is
    // the boundary that stops the next one being stored at all.
    const validatedConfig = validateProviderConfig(input.provider, input.configJson);

    return runInTenantContext(ctx, async (db) => {
        if (input.id) {
            // Update existing
            const existing = await db.integrationConnection.findFirst({
                where: { id: input.id, tenantId: ctx.tenantId },
            });
            if (!existing) throw notFound('Connection not found');

            const updated = await db.integrationConnection.update({
                where: { id: input.id },
                data: {
                    name: input.name,
                    configJson: input.configJson != null ? (validatedConfig as Prisma.InputJsonValue) : undefined,
                    ...(secretEncrypted ? { secretEncrypted } : {}),
                    isEnabled: input.isEnabled ?? true,
                },
            });

            await logEvent(db, ctx, {
                action: 'INTEGRATION_CONNECTION_UPDATED',
                entityType: 'IntegrationConnection',
                entityId: updated.id,
                detailsJson: {
                    category: 'entity_lifecycle',
                    entityName: 'IntegrationConnection',
                    operation: 'updated',
                    provider: input.provider,
                    // Names the weakening flags explicitly so the trail can
                    // answer "when did certificate verification stop?".
                    securityFlagsEnabled: enabledSecurityFlags(input.configJson),
                    summary: `Updated integration: ${input.name}`,
                },
            });

            return updated;
        }

        // Create new
        const created = await db.integrationConnection.create({
            data: {
                tenantId: ctx.tenantId,
                provider: input.provider,
                name: input.name,
                configJson: validatedConfig as Prisma.InputJsonValue,
                secretEncrypted,
                isEnabled: input.isEnabled ?? true,
            },
        });

        await logEvent(db, ctx, {
            action: 'INTEGRATION_CONNECTION_CREATED',
            entityType: 'IntegrationConnection',
            entityId: created.id,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'IntegrationConnection',
                operation: 'created',
                provider: input.provider,
                securityFlagsEnabled: enabledSecurityFlags(input.configJson),
                    summary: `Created integration: ${input.name}`,
            },
        });

        return created;
    });
}

/**
 * Remove (soft-disable) an integration connection.
 */
export async function removeIntegrationConnection(ctx: RequestContext, connectionId: string) {
    if (!ctx.permissions?.canAdmin) throw forbidden('Admin only');

    return runInTenantContext(ctx, async (db) => {
        const existing = await db.integrationConnection.findFirst({
            where: { id: connectionId, tenantId: ctx.tenantId },
        });
        if (!existing) throw notFound('Connection not found');

        await db.integrationConnection.update({
            where: { id: connectionId },
            data: { isEnabled: false },
        });

        await logEvent(db, ctx, {
            action: 'INTEGRATION_CONNECTION_DISABLED',
            entityType: 'IntegrationConnection',
            entityId: connectionId,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'IntegrationConnection',
                // 'disabled', not 'deleted'. This usecase sets isEnabled=false —
                // it does not delete the row — and its own action name, its
                // summary and the UI all say "disabled". `operation` is the
                // STRUCTURED field, and Epic C.4 ships only detailsJson to the
                // audit stream while dropping free-text `details`, so the SIEM
                // read "deleted" while the only surface saying "disabled" was
                // the one no machine sees.
                operation: 'disabled',
                provider: existing.provider,
                summary: `Disabled integration: ${existing.name}`,
            },
        });

        return { ok: true };
    });
}

// ─── Automation Execution ────────────────────────────────────────────

/**
 * Decrypt the secrets for a connection. Used internally by execution logic.
 * @internal
 */
function decryptConnectionSecrets(secretEncrypted: string | null): Record<string, unknown> {
    if (!secretEncrypted) return {};
    try {
        return JSON.parse(decryptField(secretEncrypted));
    } catch {
        logger.error('Failed to decrypt integration secrets', { component: 'integrations' });
        return {};
    }
}

/**
 * Run an automation check for a specific Control.
 * Resolves the Control's automationKey → provider → executes check → persists result.
 */
export async function runAutomationForControl(
    ctx: RequestContext,
    controlId: string,
    options: { triggeredBy?: 'scheduled' | 'manual' | 'webhook'; jobRunId?: string } = {}
) {
    const triggeredBy = options.triggeredBy ?? 'manual';

    return runInTenantContext(ctx, async (db) => {
        // 1. Fetch control + automationKey
        const control = await db.control.findFirst({
            where: { id: controlId, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true, automationKey: true, tenantId: true, name: true },
        });
        if (!control) throw notFound('Control not found');
        if (!control.automationKey) throw badRequest('Control has no automationKey');

        // 2. Resolve provider
        const resolution = registry.resolveByAutomationKey(control.automationKey);
        if (!resolution) throw badRequest(`No provider for automationKey: ${control.automationKey}`);

        const { provider, parsed } = resolution;
        if (!isScheduledCheckProvider(provider)) {
            throw badRequest(`Provider ${parsed.provider} does not support scheduled checks`);
        }

        // 3. Find active connection for this provider+tenant
        const connection = await db.integrationConnection.findFirst({
            where: {
                tenantId: ctx.tenantId,
                provider: parsed.provider,
                isEnabled: true,
            },
        });
        if (!connection) throw badRequest(`No active connection for provider: ${parsed.provider}`);

        // 4. Create PENDING execution record
        const execution = await db.integrationExecution.create({
            data: {
                tenantId: ctx.tenantId,
                connectionId: connection.id,
                provider: parsed.provider,
                automationKey: control.automationKey,
                controlId: control.id,
                status: 'RUNNING',
                triggeredBy,
                jobRunId: options.jobRunId,
            },
        });

        // 5. Execute check
        const startTime = Date.now();
        let result: CheckResult;

        try {
            const secrets = decryptConnectionSecrets(connection.secretEncrypted);
            result = await provider.runCheck({
                automationKey: control.automationKey,
                parsed,
                tenantId: ctx.tenantId,
                controlId: control.id,
                connectionConfig: {
                    ...(connection.configJson as Record<string, unknown>),
                    ...secrets,
                },
                triggeredBy,
                jobRunId: options.jobRunId,
            });
        } catch (err) {
            // Check execution failed at runtime
            const durationMs = Date.now() - startTime;
            const errorMessage = err instanceof Error ? err.message : String(err);

            await db.integrationExecution.update({
                where: { id: execution.id },
                data: {
                    status: 'ERROR',
                    errorMessage,
                    durationMs,
                    completedAt: new Date(),
                },
            });

            logger.error('Integration check execution error', {
                component: 'integrations',
                provider: parsed.provider,
                automationKey: control.automationKey,
                controlId: control.id,
                error: errorMessage,
            });

            return { execution: { ...execution, status: 'ERROR', errorMessage, durationMs } };
        }

        const durationMs = result.durationMs ?? (Date.now() - startTime);

        // 6. Persist result
        let evidenceId: string | undefined;

        // 7. Optionally create evidence
        if (result.status === 'PASSED' || result.status === 'FAILED') {
            const evidencePayload: EvidencePayload | null = provider.mapResultToEvidence(
                {
                    automationKey: control.automationKey,
                    parsed,
                    tenantId: ctx.tenantId,
                    controlId: control.id,
                    connectionConfig: {},
                    triggeredBy,
                },
                result
            );

            if (evidencePayload) {
                const evidence = await db.evidence.create({
                    data: {
                        tenantId: ctx.tenantId,
                        // Integration EvidencePayload.type uses a wider vocabulary
                        // (DOCUMENT/SCREENSHOT/LOG/CONFIGURATION/REPORT) than the
                        // Prisma EvidenceType enum (FILE/LINK/TEXT). Integration-created
                        // evidence is always text-based content; map to TEXT.
                        type: EvidenceType.TEXT,
                        title: evidencePayload.title,
                        content: evidencePayload.content,
                        category: evidencePayload.category ?? 'integration',
                        status: 'APPROVED',
                    },
                });
                await db.evidenceControlLink.create({
                    data: {
                        tenantId: ctx.tenantId,
                        evidenceId: evidence.id,
                        controlId: control.id,
                        createdByUserId: ctx.userId ?? null,
                    },
                });
                evidenceId = evidence.id;
            }
        }

        // 8. Update execution with result
        await db.integrationExecution.update({
            where: { id: execution.id },
            data: {
                status: result.status,
                resultJson: result.details as Prisma.InputJsonValue,
                evidenceId,
                errorMessage: result.errorMessage,
                durationMs,
                completedAt: new Date(),
            },
        });

        logger.info('Integration check completed', {
            component: 'integrations',
            provider: parsed.provider,
            automationKey: control.automationKey,
            status: result.status,
            durationMs,
        });

        return {
            execution: {
                id: execution.id,
                status: result.status,
                summary: result.summary,
                durationMs,
                evidenceId,
            },
        };
    });
}

/**
 * P1 — run everything a CONNECTION can produce, on demand.
 *
 * The only run path today is `runAutomationForControl` (buried on control
 * pages). This surfaces a connection-level trigger: for identity providers it
 * runs the directory/account sync; for every provider it runs each control
 * wired to that provider's automation keys. Used by the "Sync now" action and
 * fired once on connect so a fresh connection produces a visible first result.
 */
export async function syncConnection(
    ctx: RequestContext,
    connectionId: string,
    options: { triggeredBy?: 'manual' | 'scheduled' } = {}
) {
    const triggeredBy = options.triggeredBy ?? 'manual';
    const connection = await runInTenantContext(ctx, (db) =>
        db.integrationConnection.findFirst({
            where: { id: connectionId, tenantId: ctx.tenantId, isEnabled: true },
            select: { id: true, provider: true, name: true },
        })
    );
    if (!connection) throw notFound('Connection not found or disabled');

    // Identity providers: run the directory sync (populates ConnectedIdentityAccount).
    let identity: { status: string; upserted: number; deprovisioned: number } | null = null;
    if (IDENTITY_SYNC_PROVIDERS.has(connection.provider)) {
        const res = await runIdentitySync({ tenantId: ctx.tenantId, connectionId: connection.id });
        identity = { status: res.status, upserted: res.upserted, deprovisioned: res.deprovisioned };
    }

    // Run every control wired to this provider's automation keys (`provider.check`).
    const controls = await runInTenantContext(ctx, (db) =>
        db.control.findMany({
            where: { tenantId: ctx.tenantId, deletedAt: null, automationKey: { startsWith: `${connection.provider}.` } },
            select: { id: true },
            take: 200,
        })
    );
    const checks: Array<{ controlId: string; status: string }> = [];
    for (const c of controls) {
        // guardrail-allow: n+1 — one bounded check run per wired control; each is
        // an independent execution with its own IntegrationExecution row.
        try {
            const r = await runAutomationForControl(ctx, c.id, { triggeredBy });
            checks.push({ controlId: c.id, status: r.execution?.status ?? 'ERROR' });
        } catch {
            checks.push({ controlId: c.id, status: 'ERROR' });
        }
    }

    return {
        connectionId: connection.id,
        provider: connection.provider,
        identity,
        checks,
        counts: {
            total: checks.length,
            passed: checks.filter((c) => c.status === 'PASSED').length,
            failed: checks.filter((c) => c.status === 'FAILED').length,
            error: checks.filter((c) => c.status === 'ERROR').length,
        },
    };
}

// ─── Webhook Handling ────────────────────────────────────────────────

/**
 * Handle an incoming integration webhook event.
 * Persists the raw event, resolves the provider, and dispatches processing.
 */
export async function handleIncomingWebhook(
    tenantId: string | null,
    provider: string,
    payload: {
        eventType?: string;
        headers: Record<string, string>;
        body: unknown;
    }
) {
    const { prisma } = await import('@/lib/prisma');

    // 1. Persist raw event
    const event = await prisma.integrationWebhookEvent.create({
        data: {
            tenantId,
            provider,
            eventType: payload.eventType,
            payloadJson: payload.body as object,
            headersJson: payload.headers as object,
            status: 'received',
        },
    });

    // 2. Resolve webhook handler
    const webhookProvider = registry.getWebhookProvider(provider);
    if (!webhookProvider) {
        await prisma.integrationWebhookEvent.update({
            where: { id: event.id },
            data: { status: 'ignored', errorMessage: `No handler for provider: ${provider}` },
        });
        return { eventId: event.id, status: 'ignored' as const };
    }

    // 3. Process (in a try/catch to ensure event status is updated)
    try {
        // For now, mark as processed — real webhook handling comes in a later prompt
        await prisma.integrationWebhookEvent.update({
            where: { id: event.id },
            data: { status: 'processed', processedAt: new Date() },
        });

        return { eventId: event.id, status: 'processed' as const };
    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        await prisma.integrationWebhookEvent.update({
            where: { id: event.id },
            data: { status: 'error', errorMessage },
        });
        return { eventId: event.id, status: 'error' as const, errorMessage };
    }
}

// ─── Execution History ───────────────────────────────────────────────

/**
 * List recent executions for a control.
 */
export async function listExecutionsForControl(
    ctx: RequestContext,
    controlId: string,
    options: { limit?: number } = {}
) {
    return runInTenantContext(ctx, (db) =>
        db.integrationExecution.findMany({
            where: { tenantId: ctx.tenantId, controlId },
            select: {
                id: true,
                provider: true,
                automationKey: true,
                status: true,
                resultJson: true,
                evidenceId: true,
                durationMs: true,
                triggeredBy: true,
                errorMessage: true,
                executedAt: true,
                completedAt: true,
            },
            orderBy: { executedAt: 'desc' },
            take: options.limit ?? 20,
        })
    );
}

/**
 * R3-P1 — tenant-wide automated-check history (IntegrationExecution across the
 * whole tenant, not scoped to a single control). Backs the "Automated checks"
 * view on the unified /tests surface, so "show me all my control testing" has
 * ONE place instead of the checks being visible only per-control. Carries the
 * control ref so each check row names the control it exercised.
 */
export async function listAllControlChecks(
    ctx: RequestContext,
    options: { limit?: number } = {}
) {
    return runInTenantContext(ctx, (db) =>
        db.integrationExecution.findMany({
            where: {
                tenantId: ctx.tenantId,
                // A leaver pass is not a control check. It produces no evidence
                // and attests nothing — it is an offboarding action that happens
                // to be stored in the same table — so listing it here would
                // misdescribe it to whoever reads this page.
                //
                // It is also the narrower choice on access: this list is
                // reachable with `controls.view`, while every other leaver
                // surface is gated at OWNER. Excluding it keeps where-we-store-a
                // row from quietly deciding who-can-see-it.
                automationKey: { not: { endsWith: LEAVER_PASS_AUTOMATION_SUFFIX } },
            },
            select: {
                id: true,
                provider: true,
                automationKey: true,
                status: true,
                controlId: true,
                triggeredBy: true,
                errorMessage: true,
                executedAt: true,
                control: { select: { id: true, name: true, code: true } },
            },
            orderBy: { executedAt: 'desc' },
            take: options.limit ?? 200,
        })
    );
}

/**
 * P1 — list a CONNECTION's check executions (independent of any control).
 * Powers the per-connection outcome view so a connector's value doesn't
 * depend on which controls happen to be wired to it.
 */
export async function listExecutionsForConnection(
    ctx: RequestContext,
    connectionId: string,
    options: { limit?: number } = {}
) {
    return runInTenantContext(ctx, (db) =>
        db.integrationExecution.findMany({
            where: { tenantId: ctx.tenantId, connectionId },
            select: {
                id: true,
                provider: true,
                automationKey: true,
                controlId: true,
                status: true,
                resultJson: true,
                evidenceId: true,
                durationMs: true,
                triggeredBy: true,
                errorMessage: true,
                executedAt: true,
                completedAt: true,
            },
            orderBy: { executedAt: 'desc' },
            take: options.limit ?? 50,
        })
    );
}

/**
 * P1 — browse the identity accounts synced from Okta / Google Workspace.
 * Gives ConnectedIdentityAccount a roster surface (like Personnel/Devices) so
 * a directory sync produces something visible + the CONNECTED_APP access
 * review can be pre-checked instead of throwing on empty.
 */
export async function listConnectedAccounts(
    ctx: RequestContext,
    options: { provider?: string; limit?: number } = {}
) {
    return runInTenantContext(ctx, (db) =>
        db.connectedIdentityAccount.findMany({
            where: {
                tenantId: ctx.tenantId,
                ...(options.provider ? { provider: options.provider } : {}),
            },
            select: {
                id: true,
                provider: true,
                email: true,
                displayName: true,
                status: true,
                isAdmin: true,
                mfaEnrolled: true,
                // The break-glass flag and its reason. Added as FIELDS on each
                // row — the response SHAPE is unchanged, still `{ accounts: [] }`
                // — which matters because the access-review page consumes this
                // endpoint through a broken `Array.isArray` check that currently
                // fails open (see the task filed for it). Adding fields cannot
                // disturb that; changing the shape would.
                isProtected: true,
                protectionReason: true,
                lastActiveAt: true,
                syncedAt: true,
                // Presence only. `connectedAccountId` carries a field-level
                // @unique on the link side, so this is one row or none — a
                // relation select, not an N+1.
                identityLink: { select: { id: true } },
            },
            orderBy: [{ provider: 'asc' }, { email: 'asc' }],
            // Capped, with no `truncated` flag on the wire — so a caller can
            // read PRESENCE off this list but never ABSENCE. The constant is
            // shared with the access-reviews directory gate, which compares
            // the row count against it before it dares call a provider
            // unsynced. See src/lib/identity-roster.ts.
            take: options.limit ?? IDENTITY_ROSTER_PAGE_SIZE,
        }).then(async (rows) => {
            const reasons = await latestUnresolvedReasons(db, ctx.tenantId);
            // FLATTENED to two scalar fields. The relation object is stripped
            // because this response is consumed by the access-review page
            // through an `Array.isArray` check that fails open — the docblock
            // above says adding FIELDS is safe and changing the SHAPE is not,
            // and a nested object on every row is closer to the second.
            return rows.map(({ identityLink, ...account }) => ({
                ...account,
                linked: identityLink !== null,
                // Only meaningful when unlinked. A linked account carries no
                // reason, rather than a stale one from before it linked.
                unlinkedReason: identityLink === null ? (reasons.get(account.id) ?? null) : null,
            }));
        })
    );
}

/**
 * Why the last reconcile could not link each account, keyed by account id.
 *
 * WHY THIS READS AN EXECUTION ROW RATHER THAN RECOMPUTING. The reconciler is the
 * only thing that knows WHY — it holds the employee roster and the ambiguity
 * rules at the moment it ran — and it persists that verdict on the sync's own
 * IntegrationExecution row. Recomputing here would be a second implementation of
 * the matching rules, free to drift from the one that actually decides.
 *
 * The corollary is that this is a SNAPSHOT, and the caller must treat it as one:
 * `linked` is read live from the relation and is authoritative; the reason is
 * from the last sync and is only offered for accounts that are still unlinked.
 *
 * An absent reason is not "no problem" — it is "the last reconcile did not name
 * this one", which happens when the sample hit MAX_UNRESOLVED_REPORTED. The
 * caller renders that as unknown, never as fine.
 */
async function latestUnresolvedReasons(
    db: PrismaTx,
    tenantId: string,
): Promise<Map<string, string>> {
    const rows = await db.integrationExecution.findMany({
        where: { tenantId, automationKey: { endsWith: '.sync' } },
        select: { automationKey: true, resultJson: true, executedAt: true },
        orderBy: { executedAt: 'desc' },
        // Bounded, and deliberately more than one: the map is built across
        // providers, and each provider's latest sync is a different row.
        take: 20,
    });

    const seenProvider = new Set<string>();
    const out = new Map<string, string>();
    for (const row of rows) {
        // Only the MOST RECENT sync per provider contributes. An older one
        // would resurrect a reason for an account that has since linked.
        if (seenProvider.has(row.automationKey)) continue;
        seenProvider.add(row.automationKey);

        const result = row.resultJson;
        if (result === null || typeof result !== 'object' || Array.isArray(result)) continue;
        const reconcile = (result as Record<string, unknown>).linkReconcile;
        if (reconcile === null || typeof reconcile !== 'object' || Array.isArray(reconcile)) continue;
        const unresolved = (reconcile as Record<string, unknown>).unresolved;
        if (!Array.isArray(unresolved)) continue;

        for (const entry of unresolved) {
            if (entry === null || typeof entry !== 'object') continue;
            const { connectedAccountId, reason } = entry as Record<string, unknown>;
            if (typeof connectedAccountId === 'string' && typeof reason === 'string') {
                out.set(connectedAccountId, reason);
            }
        }
    }
    return out;
}

/**
 * List all automation keys available in the registry.
 * Used by the UI to populate control automationKey dropdowns.
 */
export function listAvailableAutomationKeys(): string[] {
    return registry.listAllAutomationKeys();
}

/**
 * List all registered integration providers with their metadata.
 * Used by the admin UI to show available integrations.
 */
// P3 — connector categories for the grouped Integrations hub. Central map so
// the grouping lives in one place (the OTHER `IntegrationBundle.type` taxonomy
// isn't exposed to this registry).
const PROVIDER_CATEGORY: Record<string, string> = {
    okta: 'identity',
    'google-workspace': 'identity',
    'entra-id': 'identity',
    'active-directory': 'identity',
    'aws-posture': 'cloud',
    'azure-posture': 'cloud',
    'gcp-posture': 'cloud',
    github: 'scm',
    bamboohr: 'hris',
    sharepoint: 'document',
    personnel: 'internal',
    device: 'internal',
    training: 'internal',
};

export function listAvailableProviders() {
    return registry.listProviders().map(p => ({
        id: p.id,
        displayName: p.displayName,
        description: p.description,
        supportedChecks: p.supportedChecks,
        configSchema: p.configSchema,
        // P2 — setup guidance + honest test-validation kind.
        setupGuide: p.setupGuide,
        liveValidation: p.liveValidation ?? false,
        // P3 — hub category (identity / cloud / scm / hris / document / internal).
        category: PROVIDER_CATEGORY[p.id] ?? 'other',
    }));
}

/**
 * Update a connection's test status.
 * Used by the route handler after validating a connection.
 */
export async function updateConnectionTestStatus(
    ctx: RequestContext,
    connectionId: string,
    status: string
) {
    return runInTenantContext(ctx, (db) =>
        db.integrationConnection.updateMany({
            where: { id: connectionId, tenantId: ctx.tenantId },
            data: {
                lastTestedAt: new Date(),
                lastTestStatus: status,
            },
        })
    );
}

// ─── Diagnostics ─────────────────────────────────────────────────────

/**
 * Get integration diagnostics for a tenant.
 * Returns recent executions, webhook events, and error counts.
 * Admin-only. Secrets never included.
 */
export async function getIntegrationDiagnostics(ctx: RequestContext) {
    return runInTenantContext(ctx, async (db) => {
        const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

        const [recentExecutions, recentWebhooks, errorCount24h] = await Promise.all([
            db.integrationExecution.findMany({
                where: { tenantId: ctx.tenantId },
                select: {
                    id: true,
                    provider: true,
                    automationKey: true,
                    status: true,
                    triggeredBy: true,
                    errorMessage: true,
                    durationMs: true,
                    executedAt: true,
                    completedAt: true,
                },
                orderBy: { executedAt: 'desc' },
                take: 10,
            }),
            db.integrationWebhookEvent.findMany({
                where: { tenantId: ctx.tenantId },
                select: {
                    id: true,
                    provider: true,
                    eventType: true,
                    status: true,
                    errorMessage: true,
                    createdAt: true,
                    processedAt: true,
                },
                orderBy: { createdAt: 'desc' },
                take: 10,
            }),
            db.integrationExecution.count({
                where: {
                    tenantId: ctx.tenantId,
                    status: 'ERROR',
                    executedAt: { gte: dayAgo },
                },
            }),
        ]);

        return {
            recentExecutions,
            recentWebhooks,
            errorCount24h,
            generatedAt: new Date().toISOString(),
        };
    });
}

/**
 * GAP-3 — per-connection freshness for the admin integrations-health view.
 *
 * For every ENABLED connection, the seconds since its last SUCCESSFUL
 * (PASSED) IntegrationExecution. A connection whose collector has silently
 * died — or that has never once succeeded — surfaces as `isStale`. Two
 * bounded queries (enabled connections + a grouped max(PASSED) per
 * connection); never a per-connection query in a loop.
 *
 * The DB-backed OTel gauge `integration.connection.freshness_seconds`
 * (src/lib/observability/connection-freshness.ts) reports the same signal
 * platform-wide for alerting; this is the tenant-scoped, on-demand view.
 */
export async function getConnectionsHealth(ctx: RequestContext) {
    return runInTenantContext(ctx, async (db) => {
        const connections = await db.integrationConnection.findMany({
            where: { tenantId: ctx.tenantId, isEnabled: true },
            select: { id: true, provider: true, name: true, createdAt: true, lastTestedAt: true, lastTestStatus: true },
            orderBy: [{ provider: 'asc' }, { name: 'asc' }],
            take: 500,
        });

        const now = Date.now();
        if (connections.length === 0) {
            return { connections: [], staleThresholdSeconds: CONNECTION_STALE_AFTER_SECONDS, generatedAt: new Date(now).toISOString() };
        }

        const connIds = connections.map((c) => c.id);
        // Latest SUCCESSFUL (PASSED) run — the "last success" signal.
        const groupedPassed = await db.integrationExecution.groupBy({
            by: ['connectionId'],
            where: { tenantId: ctx.tenantId, status: 'PASSED', connectionId: { in: connIds } },
            _max: { completedAt: true, executedAt: true },
        });
        // P1 — latest run of ANY status. Freshness must reflect activity, not
        // only success, and a connection that's been tested OK but not yet run
        // a check should read healthy — not "Never succeeded / Stale".
        const groupedAny = await db.integrationExecution.groupBy({
            by: ['connectionId'],
            where: { tenantId: ctx.tenantId, connectionId: { in: connIds } },
            _max: { completedAt: true, executedAt: true },
        });
        const lastSuccessByConn = new Map<string, Date>();
        for (const g of groupedPassed) {
            if (!g.connectionId) continue;
            const ts = g._max.completedAt ?? g._max.executedAt;
            if (ts) lastSuccessByConn.set(g.connectionId, ts);
        }
        const lastRunByConn = new Map<string, Date>();
        for (const g of groupedAny) {
            if (!g.connectionId) continue;
            const ts = g._max.completedAt ?? g._max.executedAt;
            if (ts) lastRunByConn.set(g.connectionId, ts);
        }

        const rows = connections.map((c) => {
            const lastSuccess = lastSuccessByConn.get(c.id) ?? null;
            // "Activity" = the most recent of any run OR a successful connection
            // test. Either is proof the connection is live.
            const lastRun = lastRunByConn.get(c.id) ?? null;
            const testOk = c.lastTestStatus === 'ok' ? c.lastTestedAt ?? null : null;
            const lastActivity = [lastRun, testOk].filter((d): d is Date => d != null)
                .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
            const secondsSinceLastSuccess = lastSuccess ? Math.max(0, Math.round((now - lastSuccess.getTime()) / 1000)) : null;
            const secondsSinceActivity = lastActivity ? Math.max(0, Math.round((now - lastActivity.getTime()) / 1000)) : null;
            const isStale = secondsSinceActivity == null || secondsSinceActivity > CONNECTION_STALE_AFTER_SECONDS;
            return {
                connectionId: c.id,
                provider: c.provider,
                name: c.name,
                lastSuccessAt: lastSuccess ? lastSuccess.toISOString() : null,
                secondsSinceLastSuccess,
                hasEverSucceeded: lastSuccess != null,
                isStale,
                // P1 — the nuanced signal the panel now renders.
                lastRunAt: lastRun ? lastRun.toISOString() : null,
                lastActivityAt: lastActivity ? lastActivity.toISOString() : null,
                secondsSinceActivity,
                lastTestedAt: c.lastTestedAt ? c.lastTestedAt.toISOString() : null,
                lastTestStatus: c.lastTestStatus,
            };
        });

        return {
            connections: rows,
            staleThresholdSeconds: CONNECTION_STALE_AFTER_SECONDS,
            staleCount: rows.filter((r) => r.isStale).length,
            generatedAt: new Date(now).toISOString(),
        };
    });
}
