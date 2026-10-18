/**
 * AGENT CREDENTIAL HYGIENE — the daily pass (#3670, step 2b).
 *
 * Reads every live API key and every external MCP server connection in one
 * tenant, runs the five rules in `lib/agentic/credential-hygiene`, and
 * reconciles the tenant's hygiene findings: a new weakness opens a Finding, a
 * weakness on a closed one reopens it, and a finding whose rule no longer fires
 * — on positive evidence from a complete read — is closed.
 *
 * FINDINGS ONLY. Nothing here writes `TenantApiKey`, `IntegrationConnection` or
 * any secret: no revocation, no rotation, no expiry, no rebinding. The one read
 * of a secret is the integration passport's "one secret read, presence only":
 * `resolveMcpCredentials` classifies the grant and only the KIND is kept; the
 * decrypted object goes out of scope on the next line.
 *
 * Findings are written through `FindingRepository` inside the tenant
 * transaction, as the harness ingest writes its own, rather than through
 * `createFinding`: the principal is the system, not a person with general write
 * authority. Title and description are built from identifiers and the key's
 * human label, and sanitised; every write is audited with actor type JOB.
 *
 * One `IntegrationExecution` row per pass (`agentic.credential_hygiene`), every
 * outcome included — an empty population is NOT_APPLICABLE with a named reason,
 * never PASSED, and a pass that threw is an ERROR row.
 *
 * The rotation age is the tenant's `apiKeyRotationDays` when set, else the
 * product default (#3708). It is read inside the same tenant transaction as the
 * credentials, so the rules are judged against the setting that held at the
 * snapshot, and the row records the days applied and their source.
 *
 * @module usecases/agent-credential-hygiene
 */
import type { Prisma } from '@prisma/client';

import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { decryptField } from '@/lib/security/encryption';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { logger } from '@/lib/observability/logger';
import { recordAgentCredentialHygiene } from '@/lib/observability/integration-metrics';
import {
    HYGIENE_AUTOMATION_KEY,
    HYGIENE_FINDING_SOURCE_KIND,
    isAgentCredential,
    planHygiene,
    resolveRotationAge,
    type ConnectionFacts,
    type ConnectionGrantKind,
    type HygieneRule,
    type KeyFacts,
} from '@/lib/agentic/credential-hygiene';
import { AGENTIC_PASS_PROVIDER } from '@/lib/agentic/owner-orphan';
import { resolveMcpCredentials } from '@/app-layer/integrations/mcp/token';
import { MCP_SERVER_PROVIDER_ID } from '@/app-layer/integrations/providers/mcp-server-provider';
import { buildSystemContext } from '../context-system';
import { drainPages, DRAIN_PAGE_SIZE } from '../jobs/drain-pages';
import { logEvent } from '../events/audit';
import { FindingRepository } from '../repositories/FindingRepository';

/** The reconcile's transaction budget. See the call site. */
const HYGIENE_TX_TIMEOUT_MS = 120_000;

export interface HygienePassResult {
    tenantId: string;
    status: 'PASSED' | 'PARTIAL' | 'NOT_APPLICABLE' | 'ERROR';
    refusal: 'NO_AGENT_CREDENTIALS' | null;
    /** Live keys in the population: bound to an agent, or admitted by `/api/mcp`. */
    agentKeys: number;
    connections: number;
    opened: number;
    reopened: number;
    resolved: number;
    held: number;
    /**
     * Existing rotation findings whose title and description were rewritten to
     * name the age now applied — while open, or as they reopened.
     */
    restated: number;
    executionId: string | null;
}

/**
 * A key's stored scopes as the authenticator reads them (`api-key-auth.ts`
 * takes the JSON array as it stands). Non-string elements are dropped: no gate
 * can match one, so dropping them changes no admission decision.
 */
function scopeStrings(scopes: Prisma.JsonValue): string[] {
    return Array.isArray(scopes) ? scopes.filter((s): s is string => typeof s === 'string') : [];
}

/**
 * The grant kind, and nothing else, of one connection's stored credential.
 *
 * `unreadable` when the secret does not decrypt or parse — no evidence about
 * the grant. `invalid` when the resolver refuses the configuration as partial:
 * a definite answer, and not an app-only grant. Neither ever throws out of here.
 */
function grantKindOf(configJson: unknown, secretEncrypted: string | null): ConnectionGrantKind {
    let secrets: Record<string, unknown> = {};
    if (secretEncrypted) {
        try {
            const parsed: unknown = JSON.parse(decryptField(secretEncrypted));
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'unreadable';
            secrets = parsed as Record<string, unknown>;
        } catch {
            return 'unreadable';
        }
    }
    const config =
        configJson !== null && typeof configJson === 'object' && !Array.isArray(configJson)
            ? (configJson as Record<string, unknown>)
            : {};
    try {
        const creds = resolveMcpCredentials(config, secrets);
        if (creds) return creds.kind;
    } catch {
        return 'invalid';
    }
    const header = secrets.authorization;
    return typeof header === 'string' && header.trim().length > 0 ? 'static-header' : 'none';
}

/** Run one tenant's pass and record it. Never throws: a broken pass is an ERROR row. */
export async function runAgentCredentialHygiene(input: {
    tenantId: string;
    jobRunId?: string;
    now?: Date;
}): Promise<HygienePassResult> {
    const now = input.now ?? new Date();
    const ctx = buildSystemContext({
        tenantId: input.tenantId,
        job: 'agent-credential-hygiene',
        ...(input.jobRunId ? { discriminator: input.jobRunId } : {}),
    });
    const zero = {
        tenantId: input.tenantId,
        agentKeys: 0,
        connections: 0,
        opened: 0,
        reopened: 0,
        resolved: 0,
        held: 0,
        restated: 0,
    };

    try {
        const outcome = await runInTenantContext(ctx, async (db) => {
            // THE ROTATION AGE, read in the same snapshot as the credentials it
            // judges. One row, one read — never per key. An absent settings row
            // is the product default, exactly as a NULL column is; a value the
            // CHECK should have refused throws, and the pass records ERROR.
            const settings = await db.tenantSecuritySettings.findUnique({
                where: { tenantId: ctx.tenantId },
                select: { apiKeyRotationDays: true },
            });
            const rotationAge = resolveRotationAge(settings?.apiKeyRotationDays);

            const keys = await drainPages((cursor) =>
                db.tenantApiKey.findMany({
                    where: {
                        tenantId: ctx.tenantId,
                        revokedAt: null,
                        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
                    },
                    select: {
                        id: true, name: true, keyPrefix: true, createdAt: true, lastUsedAt: true,
                        expiresAt: true, revokedAt: true, agentId: true, createdById: true,
                        scopes: true,
                    },
                    orderBy: { id: 'asc' },
                    take: DRAIN_PAGE_SIZE,
                    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
                }),
            );
            const connections = await drainPages((cursor) =>
                db.integrationConnection.findMany({
                    where: { tenantId: ctx.tenantId, provider: MCP_SERVER_PROVIDER_ID },
                    select: { id: true, name: true, configJson: true, secretEncrypted: true, ownerUserId: true },
                    orderBy: { id: 'asc' },
                    take: DRAIN_PAGE_SIZE,
                    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
                }),
            );
            const open = await drainPages((cursor) =>
                db.finding.findMany({
                    where: {
                        tenantId: ctx.tenantId,
                        sourceKind: HYGIENE_FINDING_SOURCE_KIND,
                        status: { not: 'CLOSED' },
                        deletedAt: null,
                    },
                    select: { id: true, sourceRef: true },
                    orderBy: { id: 'asc' },
                    take: DRAIN_PAGE_SIZE,
                    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
                }),
            );

            // The accountable owner is `IntegrationConnection.ownerUserId`
            // (integration passport P11), and only while that person holds an
            // ACTIVE membership here — the passport's own rule. A named owner
            // who has left is no owner, so the rule fires again.
            const ownerIds = [
                ...new Set(connections.map((c) => c.ownerUserId).filter((id): id is string => id !== null)),
            ];
            const activeOwners = new Set(
                ownerIds.length === 0
                    ? []
                    : (
                          await db.tenantMembership.findMany({
                              where: { tenantId: ctx.tenantId, userId: { in: ownerIds }, status: 'ACTIVE' },
                              select: { userId: true },
                              take: ownerIds.length,
                          })
                      ).map((m) => m.userId),
            );
            const connectionFacts: ConnectionFacts[] = connections.map((c) => ({
                id: c.id,
                name: c.name,
                grantKind: grantKindOf(c.configJson, c.secretEncrypted),
                namedOwnerUserId: c.ownerUserId !== null && activeOwners.has(c.ownerUserId) ? c.ownerUserId : null,
            }));
            const keyFacts: KeyFacts[] = keys.map((k) => ({
                id: k.id,
                name: k.name,
                keyPrefix: k.keyPrefix,
                createdAt: k.createdAt,
                lastUsedAt: k.lastUsedAt,
                expiresAt: k.expiresAt,
                revokedAt: k.revokedAt,
                agentId: k.agentId,
                scopes: scopeStrings(k.scopes),
            }));
            const plan = planHygiene({
                keys: keyFacts,
                connections: connectionFacts,
                openRefs: open.map((f) => f.sourceRef).filter((r): r is string => typeof r === 'string'),
                now,
                rotationAge,
            });

            // WHO ANSWERS FOR A KEY: the owner of the agent it is bound to, else
            // the person who minted it — whichever is an ACTIVE member. Two
            // batched reads. A connection's finding is unassigned: it has no
            // owner (P11), and the passport routes it to the OWNER role.
            const agentIds = [...new Set(keys.map((k) => k.agentId).filter((id): id is string => id !== null))];
            const agents =
                agentIds.length === 0
                    ? []
                    : await db.registeredAgent.findMany({
                          where: { tenantId: ctx.tenantId, id: { in: agentIds } },
                          select: { id: true, ownerUserId: true },
                          take: agentIds.length,
                      });
            const ownerByAgent = new Map(agents.map((a) => [a.id, a.ownerUserId]));
            const candidates = [
                ...new Set([...agents.map((a) => a.ownerUserId), ...keys.map((k) => k.createdById)]),
            ];
            const active =
                candidates.length === 0
                    ? new Set<string>()
                    : new Set(
                          (
                              await db.tenantMembership.findMany({
                                  where: { tenantId: ctx.tenantId, userId: { in: candidates }, status: 'ACTIVE' },
                                  select: { userId: true },
                                  take: candidates.length,
                              })
                          ).map((m) => m.userId),
                      );
            const assigneeByKey = new Map<string, string | null>();
            for (const k of keys) {
                const agentOwner = k.agentId ? ownerByAgent.get(k.agentId) ?? null : null;
                assigneeByKey.set(
                    k.id,
                    agentOwner && active.has(agentOwner)
                        ? agentOwner
                        : active.has(k.createdById)
                          ? k.createdById
                          : null,
                );
            }

            // RECONCILE, the harness ingest's shape: one read of every
            // non-deleted finding the plan touches, then create / reopen / close.
            const refs = [...new Set([...plan.assert.map((f) => f.sourceRef), ...plan.resolve])];
            const existing =
                refs.length === 0
                    ? []
                    : await db.finding.findMany({
                          where: {
                              tenantId: ctx.tenantId,
                              sourceKind: HYGIENE_FINDING_SOURCE_KIND,
                              sourceRef: { in: refs },
                              deletedAt: null,
                          },
                          select: { id: true, sourceRef: true, status: true, title: true },
                          take: refs.length,
                      });
            const byRef = new Map(existing.map((f) => [f.sourceRef as string, f]));

            const counts = { opened: 0, reopened: 0, resolved: 0, restated: 0 };
            const firedByRule: Partial<Record<HygieneRule, number>> = {};
            for (const f of plan.assert) {
                firedByRule[f.rule] = (firedByRule[f.rule] ?? 0) + 1;
                const prior = byRef.get(f.sourceRef);
                // RESTATE, for the one rule whose text quotes a tenant setting.
                // A rotation finding opened under 90 days that still fires
                // under 60 would otherwise go on quoting 90 — an age the pass no
                // longer applies. The title carries the days and their source
                // (plaintext; the description is encrypted at rest), so a title
                // mismatch is the signal and both fields are rewritten. Scoped
                // to this rule on purpose: the others quote constants.
                const title = sanitizePlainText(f.title);
                const restate =
                    prior !== undefined && f.rule === 'KEY_OLDER_THAN_ROTATION_AGE' && prior.title !== title;
                const restatedText = restate ? { title, description: sanitizePlainText(f.description) } : {};
                if (!prior) {
                    const created = await FindingRepository.create(db, ctx, {
                        severity: f.severity,
                        type: 'OBSERVATION',
                        title,
                        description: sanitizePlainText(f.description),
                        status: 'OPEN',
                        sourceKind: HYGIENE_FINDING_SOURCE_KIND,
                        sourceRef: f.sourceRef,
                        assigneeUserId:
                            f.credentialKind === 'api_key' ? assigneeByKey.get(f.credentialId) ?? null : null,
                    });
                    counts.opened += 1;
                    await logEvent(db, ctx, {
                        action: 'CREATE',
                        entityType: 'Finding',
                        entityId: created.id,
                        details: `Credential hygiene raised ${f.rule} on ${f.credentialKind} ${f.credentialId}`,
                        detailsJson: {
                            category: 'entity_lifecycle',
                            entityName: 'Finding',
                            operation: 'created',
                            after: { rule: f.rule, sourceRef: f.sourceRef, severity: f.severity },
                        },
                    });
                } else {
                    if (prior.status === 'CLOSED') {
                        await db.finding.update({
                            where: { id: prior.id },
                            data: {
                                status: 'OPEN',
                                verificationNotes: sanitizePlainText('Reopened by the credential-hygiene pass'),
                                ...restatedText,
                            },
                        });
                        counts.reopened += 1;
                        await logEvent(db, ctx, {
                            action: 'STATUS_CHANGE',
                            entityType: 'Finding',
                            entityId: prior.id,
                            details: `Credential hygiene reopened ${f.rule} on ${f.credentialKind} ${f.credentialId}`,
                            detailsJson: {
                                category: 'status_change',
                                entityName: 'Finding',
                                before: { status: 'CLOSED' },
                                after: { status: 'OPEN', sourceRef: f.sourceRef },
                            },
                        });
                    } else if (restate) {
                        await db.finding.update({ where: { id: prior.id }, data: restatedText });
                    }
                    // A text rewrite is its own audited change, whether it rode
                    // on a reopen or stood alone.
                    if (restate) {
                        counts.restated += 1;
                        await logEvent(db, ctx, {
                            action: 'UPDATE',
                            entityType: 'Finding',
                            entityId: prior.id,
                            details:
                                `Credential hygiene restated ${f.rule} on ${f.credentialKind} ${f.credentialId} ` +
                                `under the ${rotationAge.days}-day rotation age (${rotationAge.source})`,
                            detailsJson: {
                                category: 'entity_lifecycle',
                                entityName: 'Finding',
                                operation: 'updated',
                                changedFields: ['title', 'description'],
                                after: {
                                    sourceRef: f.sourceRef,
                                    rotationAgeDays: rotationAge.days,
                                    rotationAgeSource: rotationAge.source,
                                },
                            },
                        });
                    }
                }
            }

            for (const ref of plan.resolve) {
                const prior = byRef.get(ref);
                if (!prior || prior.status === 'CLOSED') continue;
                await db.finding.update({
                    where: { id: prior.id },
                    data: {
                        status: 'CLOSED',
                        verifiedAt: now,
                        verificationNotes: sanitizePlainText(
                            'Resolved by the credential-hygiene pass: its rule no longer fires on this credential',
                        ),
                    },
                });
                counts.resolved += 1;
                await logEvent(db, ctx, {
                    action: 'STATUS_CHANGE',
                    entityType: 'Finding',
                    entityId: prior.id,
                    details: `Credential hygiene resolved ${prior.sourceRef}`,
                    detailsJson: {
                        category: 'status_change',
                        entityName: 'Finding',
                        before: { status: prior.status },
                        after: { status: 'CLOSED', sourceRef: prior.sourceRef },
                    },
                });
            }

            const agentKeys = keyFacts.filter(isAgentCredential).length;
            return {
                agentKeys,
                // Live keys outside the population, counted so the row says
                // what the pass looked past rather than leaving it unstated.
                otherLiveKeys: keyFacts.length - agentKeys,
                connections: connections.length,
                ...counts,
                held: plan.held.length,
                unjudgeableConnectionIds: plan.unjudgeableConnectionIds,
                firedByRule,
                rotationAge,
            };
            // A first pass over a workspace with many keys opens a finding and
            // an audit row per (rule, key) inside this one transaction — the
            // read and the reconcile must see one snapshot — so the default
            // five-second budget is too short for it.
        }, { timeout: HYGIENE_TX_TIMEOUT_MS });

        const empty = outcome.agentKeys === 0 && outcome.connections === 0;
        const status: HygienePassResult['status'] = empty
            ? 'NOT_APPLICABLE'
            : outcome.unjudgeableConnectionIds.length > 0
              ? 'PARTIAL'
              : 'PASSED';
        const refusal = empty ? ('NO_AGENT_CREDENTIALS' as const) : null;

        const row = await runInTenantContext(ctx, (db) =>
            db.integrationExecution.create({
                data: {
                    tenantId: ctx.tenantId,
                    provider: AGENTIC_PASS_PROVIDER,
                    automationKey: HYGIENE_AUTOMATION_KEY,
                    status,
                    triggeredBy: 'scheduled',
                    jobRunId: input.jobRunId ?? null,
                    completedAt: new Date(),
                    resultJson: {
                        refusal,
                        detail: empty
                            ? 'This workspace holds no live agent credential — no key bound to an ' +
                              'agent or able to reach the MCP endpoint — and no external MCP server ' +
                              'connection, so no credential was checked. An empty population is ' +
                              'recorded as such — it is not a clean result.'
                            : null,
                        population: {
                            agentKeys: outcome.agentKeys,
                            otherLiveKeys: outcome.otherLiveKeys,
                            mcpServerConnections: outcome.connections,
                        },
                        // The age APPLIED, and where it came from — never the
                        // default reported for a tenant that set its own.
                        rotationAge: { days: outcome.rotationAge.days, source: outcome.rotationAge.source },
                        firedByRule: outcome.firedByRule,
                        findings: {
                            opened: outcome.opened,
                            reopened: outcome.reopened,
                            resolved: outcome.resolved,
                            held: outcome.held,
                            restated: outcome.restated,
                        },
                        // Named, never dropped: a connection the pass could not
                        // judge is a fact about this run, and its findings stay
                        // as they were.
                        skipped: outcome.unjudgeableConnectionIds.map((connectionId) => ({
                            connectionId,
                            reason: 'GRANT_KIND_UNRESOLVED',
                        })),
                    } as Prisma.InputJsonValue,
                },
                select: { id: true },
            }),
        );

        recordAgentCredentialHygiene({
            outcome: empty ? 'no_agent_credentials' : status === 'PARTIAL' ? 'partial' : 'completed',
            opened: outcome.opened,
            reopened: outcome.reopened,
            resolved: outcome.resolved,
        });
        logger.info('agent credential hygiene pass complete', {
            component: 'agent-credential-hygiene',
            tenantId: ctx.tenantId,
            agentKeys: outcome.agentKeys,
            connections: outcome.connections,
            opened: outcome.opened,
            reopened: outcome.reopened,
            resolved: outcome.resolved,
            restated: outcome.restated,
            rotationAgeDays: outcome.rotationAge.days,
            rotationAgeSource: outcome.rotationAge.source,
        });

        return {
            tenantId: input.tenantId,
            status,
            refusal,
            agentKeys: outcome.agentKeys,
            connections: outcome.connections,
            opened: outcome.opened,
            reopened: outcome.reopened,
            resolved: outcome.resolved,
            held: outcome.held,
            restated: outcome.restated,
            executionId: row.id,
        };
    } catch (err) {
        logger.error('agent credential hygiene pass threw', {
            component: 'agent-credential-hygiene',
            tenantId: ctx.tenantId,
            errorMessage: err instanceof Error ? err.message : 'non-Error thrown',
        });
        let executionId: string | null = null;
        try {
            const row = await runInTenantContext(ctx, (db) =>
                db.integrationExecution.create({
                    data: {
                        tenantId: ctx.tenantId,
                        provider: AGENTIC_PASS_PROVIDER,
                        automationKey: HYGIENE_AUTOMATION_KEY,
                        status: 'ERROR',
                        triggeredBy: 'scheduled',
                        jobRunId: input.jobRunId ?? null,
                        completedAt: new Date(),
                        resultJson: {
                            refusal: null,
                            detail: `The pass could not run to completion: ${(err instanceof Error ? err.message : String(err)).slice(0, 300)}`,
                        },
                    },
                    select: { id: true },
                }),
            );
            executionId = row.id;
        } catch (writeErr) {
            logger.error('agent credential hygiene pass threw and its record could not be written', {
                component: 'agent-credential-hygiene',
                tenantId: ctx.tenantId,
                errorMessage: writeErr instanceof Error ? writeErr.message : 'non-Error thrown',
            });
        }
        recordAgentCredentialHygiene({ outcome: 'error', opened: 0, reopened: 0, resolved: 0 });
        return { ...zero, status: 'ERROR', refusal: null, executionId };
    }
}
