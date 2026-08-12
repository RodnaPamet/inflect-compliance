/**
 * Webhook Processor — Core Processing Usecase
 *
 * Handles the full lifecycle of an incoming integration webhook:
 *   1. Persist raw event (IntegrationWebhookEvent)
 *   2. Resolve tenant from connection (never trust caller)
 *   3. Verify webhook signature
 *   4. Dispatch to provider handler
 *   5. Create Evidence when provider emits evidence-worthy results
 *   6. Create IntegrationExecution records for check results
 *
 * SECURITY:
 *   - Tenant ID is resolved from IntegrationConnection, never from request
 *   - Signature verification is mandatory when provider supports it
 *   - Raw payload is retained for audit/replay (bounded by auto-cleanup)
 *
 * @module usecases/webhook-processor
 */
import { EvidenceType } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import '../integrations/bootstrap'; // populate the provider registry in THIS module graph (see usecases/integrations)
import { registry, integrationRegistry } from '../integrations/registry';
import { isWebhookEventProvider } from '../integrations/types';
import type { WebhookProcessResult } from '../integrations/types';
import { PrismaSyncMappingStore } from '../integrations/prisma-sync-store';
import { PrismaLocalStore } from '../integrations/prisma-local-store';
import { extractSignature, verifyHmacSha256, verifyGitHubSignature } from '../integrations/webhook-crypto';
import { decryptField } from '@/lib/security/encryption';
import { logger } from '@/lib/observability/logger';
import { getPermissionsForRole } from '@/lib/permissions';
import crypto from 'crypto';
import { buildSystemContext } from '../context';

/** Dedup window: ignore duplicate payloads within this period */
const DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

/** Max webhook events per provider per minute (rate limiting) */
export const WEBHOOK_RATE_LIMIT = 60;

// ─── Types ───────────────────────────────────────────────────────────

export interface WebhookInput {
    provider: string;
    rawBody: string;
    headers: Record<string, string>;
}

export type WebhookResult =
    | { status: 'processed'; eventId: string; executionsCreated: number; evidenceCreated: number }
    | { status: 'ignored'; eventId: string; reason: string }
    | { status: 'auth_failed'; eventId?: string }
    | { status: 'invalid_provider' }
    | { status: 'error'; eventId: string; errorMessage: string };

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Three states, not two.
 *
 * `absent`         — no secret configured. An operator action.
 * `undecryptable`  — decryptField threw. Usually DEK drift or a rotation gone
 *                    wrong: an INFRASTRUCTURE alarm.
 * `malformed`      — decrypted fine but is not JSON. A data-shape bug.
 *
 * Collapsing all three to `{}` (the previous behaviour) meant a key-management
 * failure and an unconfigured connection were indistinguishable, so neither
 * could be alerted on correctly.
 */
type SecretState =
    | { state: 'ok'; secrets: Record<string, unknown> }
    | { state: 'absent' }
    | { state: 'undecryptable' }
    | { state: 'malformed' };

function decryptWebhookSecret(secretEncrypted: string | null): SecretState {
    if (!secretEncrypted) return { state: 'absent' };
    let plaintext: string;
    try {
        plaintext = decryptField(secretEncrypted);
    } catch {
        return { state: 'undecryptable' };
    }
    try {
        return { state: 'ok', secrets: JSON.parse(plaintext) };
    } catch {
        return { state: 'malformed' };
    }
}

/**
 * Unwrap a `SecretState` to the plain secrets bag, or `{}` when unusable.
 *
 * Needed because `SecretState` is STRUCTURALLY assignable to
 * `Record<string, unknown>` — so passing the wrapper straight to
 * `getWebhookSecret` typechecks cleanly and then silently yields null at
 * runtime, skipping the gate that reads it. tsc cannot catch that; this helper
 * makes the unwrap explicit at every call site.
 */
function secretsOf(state: SecretState): Record<string, unknown> {
    return state.state === 'ok' ? state.secrets : {};
}

function getWebhookSecret(secrets: Record<string, unknown>): string | null {
    // Common secret key names across providers
    for (const key of ['webhookSecret', 'webhook_secret', 'secret', 'signingSecret']) {
        if (typeof secrets[key] === 'string' && secrets[key]) {
            return secrets[key] as string;
        }
    }
    return null;
}

/**
 * Verify webhook signature for a specific provider.
 * Returns true if verification passed or was skipped (no secret configured).
 * Returns false only when verification was attempted and failed.
 */
function verifyProviderSignature(
    provider: string,
    rawBody: string,
    headers: Record<string, string>,
    webhookSecret: string | null
): { verified: boolean; reason?: string } {
    // No secret configured — in dev, allow; in prod, this should be an error
    // but we log a warning and allow it (admin's responsibility to configure)
    if (!webhookSecret) {
        // FAIL CLOSED.
        //
        // This returned `{ verified: true, reason: 'no_secret_configured' }`,
        // with a comment conceding "in prod this should be an error". Combined
        // with an unscoped connection lookup that breaks on the first verified
        // match, ONE tenant leaving its secret unset made that tenant the
        // catch-all destination for any forged webhook for the provider —
        // creating IntegrationExecution rows and Evidence in a tenant
        // the sender never named.
        //
        // BEHAVIOUR CHANGE: connections with no configured secret stop
        // accepting deliveries. That is the point — they were never
        // authenticated — but it is a live functional change, not a silent
        // hardening. See the PR for the coverage query.
        logger.error('Webhook rejected: no signing secret configured for connection', {
            component: 'integrations',
            provider,
        });
        return { verified: false, reason: 'no_secret_configured' };
    }

    const signature = extractSignature(provider, headers);
    if (!signature) {
        return { verified: false, reason: 'missing_signature_header' };
    }

    // Provider-specific verification
    switch (provider) {
        case 'github': {
            const sigHeader = headers['x-hub-signature-256'] || '';
            return {
                verified: verifyGitHubSignature(rawBody, sigHeader, webhookSecret),
                reason: 'github_hmac',
            };
        }
        case 'gitlab': {
            // GitLab uses a simple token comparison in X-Gitlab-Token
            const token = headers['x-gitlab-token'] || '';
            return {
                verified: token === webhookSecret,
                reason: 'gitlab_token',
            };
        }
        default: {
            // Generic HMAC-SHA256 verification
            return {
                verified: verifyHmacSha256(rawBody, signature, webhookSecret, 'hex'),
                reason: 'generic_hmac',
            };
        }
    }
}

// ─── Main Entry Point ────────────────────────────────────────────────

/**
 * Process an incoming webhook event end-to-end.
 *
 * This is the primary entry point called by the webhook route handler.
 * It handles every step from raw event persistence through evidence creation.
 */
export async function processIncomingWebhook(input: WebhookInput): Promise<WebhookResult> {
    const { provider, rawBody, headers } = input;
    const requestId = crypto.randomUUID();

    // 1. Check if we have a registered provider
    const providerImpl = registry.getProvider(provider);
    if (!providerImpl) {
        logger.warn('Webhook for unknown provider', { component: 'integrations', provider, requestId });
        return { status: 'invalid_provider' };
    }

    // 2. Parse body
    let parsedBody: unknown;
    try {
        parsedBody = JSON.parse(rawBody);
    } catch {
        parsedBody = rawBody; // Store raw if not JSON
    }

    // 2.5. Payload hash — computed here, but the DEDUPE CHECK now runs AFTER
    // signature verification (step 6a). See the note there.
    const payloadHash = crypto.createHash('sha256').update(rawBody).digest('hex');

    // 3. Persist raw event immediately (before validation)
    let event;
    try {
        event = await prisma.integrationWebhookEvent.create({
            data: {
                provider,
                eventType: typeof parsedBody === 'object' && parsedBody !== null
                    ? (parsedBody as Record<string, unknown>).action as string
                      ?? (parsedBody as Record<string, unknown>).event_type as string
                      ?? null
                    : null,
                payloadJson: (typeof parsedBody === 'object' && parsedBody !== null ? parsedBody : { raw: rawBody }) as object,
                headersJson: sanitizeHeaders(headers) as object,
                payloadHash,
                status: 'received',
            },
        });
    } catch (err) {
        logger.error('Failed to persist webhook event', {
            component: 'integrations',
            provider,
            err: err instanceof Error ? err : new Error(String(err)),
        });
        return { status: 'error', eventId: '', errorMessage: 'Failed to persist event' };
    }

    // 4. Find connections for this provider (resolve tenant from DB, not from caller)
    const connections = await prisma.integrationConnection.findMany({
        where: { provider, isEnabled: true },
        select: {
            id: true,
            tenantId: true,
            secretEncrypted: true,
            configJson: true,
        },
    });

    if (connections.length === 0) {
        await prisma.integrationWebhookEvent.update({
            where: { id: event.id },
            data: { status: 'ignored', errorMessage: 'No active connections for provider' },
        });
        return { status: 'ignored', eventId: event.id, reason: 'no_connections' };
    }

    // 5. Try to verify and match to a connection
    let matchedConnection: typeof connections[0] | null = null;

    // Collect ALL matches rather than breaking on the first.
    //
    // With fail-open, "first verified wins" meant the first secretless
    // connection swallowed every forged delivery. With fail-closed a match is
    // a real HMAC match — but two connections sharing a secret is a
    // misconfiguration, and silently picking whichever the database returned
    // first would route a tenant's data to the other tenant. Refuse to guess.
    const matches: typeof connections = [];
    for (const conn of connections) {
        const secretState = decryptWebhookSecret(conn.secretEncrypted);
        if (secretState.state !== 'ok') {
            // Emitted per-connection, not hoisted: a fleet-wide misconfiguration
            // has to be visible per connection to be actionable.
            logger.error('Webhook connection has no usable signing secret', {
                component: 'integrations',
                provider,
                connectionId: conn.id,
                secretState: secretState.state,
            });
            continue;
        }
        const webhookSecret = getWebhookSecret(secretState.secrets);
        const verification = verifyProviderSignature(provider, rawBody, headers, webhookSecret);
        if (verification.verified) matches.push(conn);
    }

    if (matches.length > 1) {
        logger.error('Webhook signature matched multiple connections — refusing to guess', {
            component: 'integrations',
            provider,
            matchCount: matches.length,
        });
        await prisma.integrationWebhookEvent.update({
            where: { id: event.id },
            data: { status: 'error', errorMessage: 'Ambiguous signature match across connections' },
        });
        return { status: 'auth_failed', eventId: event.id };
    }
    matchedConnection = matches[0] ?? null;

    if (!matchedConnection) {
        await prisma.integrationWebhookEvent.update({
            where: { id: event.id },
            data: { status: 'error', errorMessage: 'Signature verification failed for all connections' },
        });
        return { status: 'auth_failed', eventId: event.id };
    }

    // 6. Update event with resolved tenant
    await prisma.integrationWebhookEvent.update({
        where: { id: event.id },
        data: { tenantId: matchedConnection.tenantId },
    });

    // 6a. Replay/idempotency check — AFTER verification, SCOPED to the tenant.
    //
    // This used to run before any authentication, against rows in either
    // `processed` OR `received` state, with no tenant predicate. Two problems,
    // both exploitable by anyone who could reach the endpoint:
    //
    //   • POISONING. An unverified request persists a `received` row (step 3,
    //     which is deliberately pre-auth so a forged delivery is still
    //     forensically visible). Replaying an observed body therefore planted a
    //     row that caused the GENUINE redelivery to be dropped as
    //     `duplicate_payload` — denial-of-delivery with no credentials.
    //   • CROSS-TENANT SUPPRESSION. The lookup had no tenant predicate, so an
    //     identical body legitimately delivered to tenant B within the window
    //     was discarded because tenant A had already received it.
    //
    // Both close by moving the check here: the tenant is known, and only rows
    // that actually reached `processed` — i.e. passed signature verification —
    // can suppress anything. An attacker's row never reaches that state.
    //
    // Trade-off accepted: a genuine duplicate arriving while the first is still
    // in flight is no longer collapsed. Processing a rare in-flight duplicate is
    // strictly better than dropping a real delivery because someone poisoned the
    // cache.
    const duplicateEvent = await prisma.integrationWebhookEvent.findFirst({
        where: {
            provider,
            payloadHash,
            tenantId: matchedConnection.tenantId,
            createdAt: { gte: new Date(Date.now() - DEDUP_WINDOW_MS) },
            status: 'processed',
            id: { not: event.id },
        },
        select: { id: true },
    });

    if (duplicateEvent) {
        logger.info('Webhook deduplicated — verified replay detected', {
            component: 'integrations',
            provider,
            requestId,
            duplicateOf: duplicateEvent.id,
            payloadHash: payloadHash.slice(0, 12),
        });
        await prisma.integrationWebhookEvent.update({
            where: { id: event.id },
            data: { status: 'ignored', errorMessage: 'Duplicate of an already-processed delivery' },
        });
        return { status: 'ignored', eventId: duplicateEvent.id, reason: 'duplicate_payload' };
    }

    // 7. Establish tenant execution context.
    //
    // Inbound webhook — no user is on the other end, so the actor is the
    // platform. `principal` keeps the existing `system:webhook` id (rows
    // already carry it) and `requestId` keeps the delivery's own id, which
    // is what ties the trail back to the provider's payload.
    const ctx = buildSystemContext({
        tenantId: matchedConnection.tenantId,
        job: 'webhook',
        principal: 'system:webhook',
        requestId,
        permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
    });

    // 8. Dispatch to provider handler if it supports webhooks
    let processResult: WebhookProcessResult = { status: 'ignored' };
    let executionsCreated = 0;
    let evidenceCreated = 0;

    if (isWebhookEventProvider(providerImpl)) {
        try {
            const secrets = secretsOf(decryptWebhookSecret(matchedConnection.secretEncrypted));
            const webhookSecret = getWebhookSecret(secrets);

            // Verify using provider's own verification method
            if (webhookSecret) {
                const isValid = providerImpl.verifyWebhookSignature(
                    {
                        provider,
                        headers,
                        body: parsedBody,
                        // The bytes the provider signed. Without this the
                        // verifier re-serialises and the HMAC can never match
                        // for payloads that do not round-trip byte-identically.
                        rawBody,
                        receivedAt: new Date(),
                    },
                    webhookSecret
                );
                if (!isValid) {
                    await prisma.integrationWebhookEvent.update({
                        where: { id: event.id },
                        data: { status: 'error', errorMessage: 'Provider signature verification failed' },
                    });
                    return { status: 'auth_failed', eventId: event.id };
                }
            }

            processResult = await providerImpl.handleWebhook(
                ctx,
                {
                    provider,
                    eventType: event.eventType ?? undefined,
                    headers,
                    body: parsedBody,
                    receivedAt: new Date(),
                },
                {
                    ...(matchedConnection.configJson as Record<string, unknown>),
                    ...secretsOf(decryptWebhookSecret(matchedConnection.secretEncrypted)),
                }
            );

            // 8. Create executions/evidence for triggered automation keys
            if (processResult.triggeredKeys && processResult.triggeredKeys.length > 0) {
                for (const automationKey of processResult.triggeredKeys) {
                    // Find controls with this automationKey in the tenant
                    const controls = await prisma.control.findMany({
                        where: {
                            tenantId: matchedConnection.tenantId,
                            automationKey,
                            deletedAt: null,
                        },
                        select: { id: true, name: true },
                    });

                    for (const control of controls) {
                        // Create execution record
                        const execution = await prisma.integrationExecution.create({
                            data: {
                                tenantId: matchedConnection.tenantId,
                                connectionId: matchedConnection.id,
                                provider,
                                automationKey,
                                controlId: control.id,
                                status: 'PASSED',
                                triggeredBy: 'webhook',
                                resultJson: { source: 'webhook', eventId: event.id },
                                completedAt: new Date(),
                            },
                        });
                        executionsCreated++;

                        // Create evidence for the check result
                        const evidence = await prisma.evidence.create({
                            data: {
                                tenantId: matchedConnection.tenantId,
                                // Webhook-created evidence is text-based; EvidenceType enum uses FILE/LINK/TEXT.
                                // Map to TEXT as the semantically closest value for automation-generated content.
                                type: EvidenceType.TEXT,
                                title: `[${provider}] Webhook: ${automationKey}`,
                                content: `Automated evidence from ${provider} webhook event.\nEvent type: ${event.eventType ?? 'unknown'}\nExecution ID: ${execution.id}`,
                                category: 'integration',
                                // SUBMITTED, not APPROVED.
                                //
                                // APPROVED here put automation-authored rows
                                // into the compliance record as reviewed
                                // evidence without any human ever seeing them —
                                // and it bypassed the evidence state machine
                                // outright: `EVIDENCE_TRANSITIONS` allows
                                // APPROVED only from SUBMITTED, and only via
                                // `reviewEvidence`, which additionally enforces
                                // segregation of duties. A direct write is not
                                // a shortcut through that gate, it is a hole in
                                // it. For a GRC product this is a
                                // record-integrity defect, not a UX one.
                                //
                                // SUBMITTED rather than DRAFT because the
                                // content IS complete — nobody is still
                                // authoring it — so it belongs in the review
                                // queue, which is exactly what SUBMITTED means
                                // here. With no submitter recorded, the
                                // no-self-approval rule leaves any reviewer
                                // eligible.
                                status: 'SUBMITTED',
                            },
                        });
                        await prisma.evidenceControlLink.create({
                            data: {
                                tenantId: matchedConnection.tenantId,
                                evidenceId: evidence.id,
                                controlId: control.id,
                                createdByUserId: null,
                            },
                        });
                        evidenceCreated++;
                    }
                }
            }

        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            logger.error('Webhook processing error in ProviderImpl', {
                component: 'integrations',
                provider,
                eventId: event.id,
                error: err instanceof Error ? err : new Error(String(err)),
            });

            await prisma.integrationWebhookEvent.update({
                where: { id: event.id },
                data: { status: 'error', errorMessage, processedAt: new Date() },
            });

            return { status: 'error', eventId: event.id, errorMessage };
        }
    }

    // 8.5. Dispatch to sync orchestrator if the provider supports CRUD orchestration
    if (integrationRegistry.has(provider)) {
        try {
            // Build complete connection config by merging stored config + decrypted secrets.
            // This ensures the orchestrator gets all required fields (e.g. owner, repo, token for GitHub).
            const connectionSecrets = secretsOf(decryptWebhookSecret(matchedConnection.secretEncrypted));
            const connectionConfig = {
                ...(matchedConnection.configJson as Record<string, unknown>),
                ...connectionSecrets,
            };

            const orchestrator = integrationRegistry.createOrchestrator(provider, {
                config: connectionConfig,
                store: new PrismaSyncMappingStore(),
                localStore: new PrismaLocalStore(),
                logger: {
                    log: (syncEvent: Record<string, unknown>) => logger.info('Sync event from webhook', {
                        component: 'integrations',
                        provider,
                        eventId: event.id,
                        syncEvent,
                    }),
                },
            });

            if (orchestrator) {
                const syncResult = await orchestrator.handleWebhookEvent({
                    ctx,
                    provider,
                    eventType: event.eventType || 'unknown',
                    payload: parsedBody as Record<string, unknown>,
                    connectionId: matchedConnection.id,
                });

                if (syncResult.processed) {
                    logger.info('Webhook dispatched to sync orchestrator', {
                        component: 'integrations',
                        provider,
                        eventId: event.id,
                        tenantId: matchedConnection.tenantId,
                        syncCount: syncResult.syncCount,
                        actions: syncResult.results.map(r => r.action),
                    });
                }
            }
        } catch (err) {
            // Sync orchestrator failures are logged but do NOT fail the webhook.
            // The webhook's primary job (persist event, run provider checks, create evidence)
            // has already succeeded above. Sync is a best-effort follow-on step.
            logger.error('Sync orchestrator dispatch failed', {
                component: 'integrations',
                provider,
                eventId: event.id,
                tenantId: matchedConnection.tenantId,
                error: err instanceof Error ? err : new Error(String(err)),
            });
        }
    }

    // 9. Finalize event status
    const finalStatus = processResult.status === 'error' ? 'error' : 'processed';
    await prisma.integrationWebhookEvent.update({
        where: { id: event.id },
        data: {
            status: finalStatus,
            processedAt: new Date(),
            errorMessage: processResult.errorMessage || null,
        },
    });

    logger.info('Webhook processed', {
        component: 'integrations',
        provider,
        eventId: event.id,
        tenantId: matchedConnection.tenantId,
        status: finalStatus,
        executionsCreated,
        evidenceCreated,
    });

    return {
        status: 'processed',
        eventId: event.id,
        executionsCreated,
        evidenceCreated,
    };
}

// ─── Header Sanitization ─────────────────────────────────────────────

/**
 * Sanitize headers for storage — remove sensitive values, keep structure.
 */
function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
    const SENSITIVE_HEADERS = new Set([
        'authorization',
        'cookie',
        'set-cookie',
        'x-api-key',
    ]);

    const sanitized: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
        if (SENSITIVE_HEADERS.has(key.toLowerCase())) {
            sanitized[key] = '[REDACTED]';
        } else {
            sanitized[key] = value;
        }
    }
    return sanitized;
}
