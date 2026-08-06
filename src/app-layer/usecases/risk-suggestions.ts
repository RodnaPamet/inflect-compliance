/**
 * AI Risk Suggestions — Use Cases (Enterprise-hardened)
 *
 * Business logic for managing AI-generated risk suggestion sessions.
 * All operations are tenant-scoped, rate-limited, feature-gated, and audit-logged.
 *
 * Privacy: Only sanitized asset/framework data is sent to external AI models.
 * Rate limits: Per-tenant daily quota + per-user burst protection.
 * Feature gate: Global flag, role-based, and optional plan-based gating.
 * Audit: Every generate/apply/dismiss action is logged with full context.
 */
import { runInTenantContext } from '@/lib/db-context';
import { recordScoreEvent } from './risk-score-events';
import { logEvent } from '@/app-layer/events/audit';
import type { RequestContext } from '@/app-layer/types';
import { getProvider } from '@/app-layer/ai/risk-assessment';
import type { RiskAssessmentInput, RiskAssessmentAsset } from '@/app-layer/ai/risk-assessment/types';
import type { ApplySessionInput, RiskAssessmentApiInput } from '@/app-layer/ai/risk-assessment/schemas';
import { forbidden, notFound } from '@/lib/errors/types';
import { sanitizeProviderInput, describePayload } from '@/app-layer/ai/risk-assessment/privacy-sanitizer';
import { detectInputAnomalies } from '@/app-layer/ai/risk-assessment/input-anomaly';
import { guardUntrustedInput, guardEgress, assertGuardAllowed } from '@/app-layer/ai/guard';
import { buildInferenceLog } from '@/app-layer/ai/risk-assessment/inference-log';
import { applyOutputGuard } from '@/app-layer/ai/risk-assessment/output-guard';
import { checkRateLimit, recordGeneration } from '@/app-layer/ai/risk-assessment/rate-limiter';
import { enforceFeatureGate } from '@/app-layer/ai/risk-assessment/feature-gate';
import { bumpEntityCacheVersion } from '@/lib/cache/list-cache';
import { recordAiRiskAssessment } from '@/lib/observability/metrics';
import { logAiDecision, recordDecisionOutcome } from '@/app-layer/ai/decision-log';
import { RiskRepository } from '../repositories/RiskRepository';

// ─── Generate Risk Suggestions ───

export async function generateRiskSuggestions(
    ctx: RequestContext,
    apiInput: RiskAssessmentApiInput,
) {
    // 1. Feature gate (global flag + per-feature flag + role + optional plan)
    enforceFeatureGate(ctx, 'risk');

    // 2. Permission check (admin/editor only — redundant with feature gate but explicit)
    if (!ctx.permissions.canWrite) {
        throw forbidden('Only editors and admins can generate AI risk suggestions');
    }

    // 3. Rate limit check (before any DB work)
    await checkRateLimit(ctx.tenantId, ctx.userId);

    return runInTenantContext(ctx, async (db) => {
        // 4. Fetch tenant profile
        const tenant = await db.tenant.findUnique({ where: { id: ctx.tenantId } });
        if (!tenant) throw notFound('Tenant not found');

        // 5. Fetch assets by IDs (or all if none specified)
        const assetWhere = apiInput.assetIds.length > 0
            ? { tenantId: ctx.tenantId, id: { in: apiInput.assetIds }, deletedAt: null }
            : { tenantId: ctx.tenantId, deletedAt: null };
        const dbAssets = await db.asset.findMany({ where: assetWhere, take: 50 });

        const assets: RiskAssessmentAsset[] = dbAssets.map(a => ({
            id: a.id,
            name: a.name,
            type: a.type,
            criticality: a.criticality,
            classification: a.classification,
            confidentiality: a.confidentiality,
            integrity: a.integrity,
            availability: a.availability,
        }));

        // 6. Fetch existing controls (to avoid suggesting already-mitigated risks)
        const existingControls = await db.control.findMany({
            where: { tenantId: ctx.tenantId },
            select: { name: true, code: true },
            take: 100,
        });
        const controlNames = existingControls.map(c => c.code ?? c.name);

        // 7. Build provider input
        const providerInput: RiskAssessmentInput = {
            tenantIndustry: tenant.industry,
            tenantContext: apiInput.context ?? tenant.context,
            frameworks: apiInput.frameworks,
            assets,
            existingControls: controlNames,
            maxRiskScale: tenant.maxRiskScale,
        };

        // 8. *** PRIVACY: Sanitize before sending to AI ***
        const sanitizedInput = sanitizeProviderInput(providerInput);
        const payloadDescription = describePayload(sanitizedInput);

        // 8b. AISVS C11.4.1 / C12.2.2-4 — screen the sanitized input for
        // prompt-injection / probing signals. Non-blocking (the C2 trust
        // boundary already contains the attack); we record it for monitoring
        // and flag the resulting draft for careful human review (C11.4.2 —
        // the human is the action gate, since AI output is advisory).
        const anomalyReport = detectInputAnomalies(sanitizedInput);

        // 8c. AI Guard (content-aware). Normalizes then scans the assembled
        // untrusted tenant text for prompt-injection — catching base64 /
        // homoglyph / zero-width evasion the delimiter + reserved-token
        // neutralizer alone don't. Runs ALONGSIDE that fence (defence in
        // depth), never instead of it. The egress scan runs on the outbound
        // payload AFTER the privacy sanitizer (sanitize → egress scan).
        const untrustedText = [
            sanitizedInput.tenantIndustry ?? '',
            sanitizedInput.tenantContext ?? '',
            ...sanitizedInput.frameworks,
            ...sanitizedInput.assets.map((a) => a.name),
            ...(sanitizedInput.existingControls ?? []),
        ].join('\n');
        const inputGuard = await guardUntrustedInput(ctx, untrustedText, {
            source: 'risk-assessment',
            db,
        });
        const outboundGuard = await guardEgress(ctx, sanitizedInput, {
            source: 'risk-assessment:outbound',
            db,
        });
        // Invariant: a strict-mode malicious input verdict OR a secret-leak
        // egress hit aborts the model call before any suggestion is created.
        assertGuardAllowed(inputGuard);
        assertGuardAllowed(outboundGuard);

        // 9. Create session record (DRAFT → will be GENERATED on success)
        const session = await db.riskSuggestionSession.create({
            data: {
                tenantId: ctx.tenantId,
                createdByUserId: ctx.userId,
                status: 'DRAFT',
                inputJson: JSON.stringify(sanitizedInput), // Store sanitized input only
                provider: 'pending',
            },
        });

        // 9b. AISVS C12.2.3 / C12.2.4 — if the input screen flagged anything,
        // emit a dedicated, AI-specific threat event carrying the offending
        // field + kind + a short snippet (structured detailsJson only — no raw
        // free-text shipped to the SIEM). Separate from the generation event so
        // it alerts even if generation later succeeds normally.
        if (anomalyReport.flagged) {
            await logEvent(db, ctx, {
                action: 'AI_RISK_INPUT_ANOMALY',
                entityType: 'RiskSuggestionSession',
                entityId: session.id,
                details: `AI risk-assessment input flagged ${anomalyReport.anomalies.length} anomaly signal(s)`,
                detailsJson: {
                    category: 'custom',
                    event: 'ai_risk_input_anomaly',
                    anomalies: anomalyReport.anomalies.map((a) => ({
                        field: a.field,
                        kind: a.kind,
                        snippet: a.snippet,
                    })),
                },
                metadata: {
                    anomalyCount: anomalyReport.anomalies.length,
                    kinds: [...new Set(anomalyReport.anomalies.map((a) => a.kind))],
                },
            });
        }

        // 10. Call provider with sanitized input.
        // AI sovereignty (DS-1): resolve the tenant's AI-residency posture.
        // LOCAL_ONLY forces a local provider and refuses external inference.
        const secSettings = await db.tenantSecuritySettings.findUnique({
            where: { tenantId: ctx.tenantId },
            select: { aiResidency: true, aiLocalBaseUrl: true, aiLocalModel: true },
        });
        const provider = getProvider({
            residency: secSettings?.aiResidency,
            localBaseUrl: secSettings?.aiLocalBaseUrl,
            localModel: secSettings?.aiLocalModel,
        });
        const aiStart = Date.now();
        let output;
        try {
            output = await provider.generateSuggestions(sanitizedInput);
        } catch (err) {
            // AISVS C12 — record the failed AI generation before re-raising.
            recordAiRiskAssessment({
                provider: provider.providerName,
                outcome: 'failure',
                durationMs: Date.now() - aiStart,
                fallback: true,
            });
            // Mark session as failed
            await db.riskSuggestionSession.update({
                where: { id: session.id },
                data: {
                    status: 'DISMISSED',
                    errorMessage: err instanceof Error ? err.message : 'Unknown error',
                },
            });

            // Audit log the failure — with a structured inference log so a
            // failed inference is as parseable as a successful one (C12.1.3).
            await logEvent(db, ctx, {
                action: 'AI_RISK_SUGGESTIONS_GENERATED',
                entityType: 'RiskSuggestionSession',
                entityId: session.id,
                details: `AI generation FAILED: ${err instanceof Error ? err.message : 'Unknown error'}`,
                detailsJson: {
                    category: 'entity_lifecycle',
                    entityName: 'RiskSuggestionSession',
                    operation: 'created',
                    summary: 'AI_RISK_SUGGESTIONS_GENERATED',
                    inferenceLog: buildInferenceLog({
                        provider: provider.providerName,
                        model: 'unknown',
                        outcome: 'failure',
                        durationMs: Date.now() - aiStart,
                        suggestionCount: 0,
                        safety: {
                            outputRedactions: 0,
                            droppedLowConfidence: 0,
                            inputAnomalyCount: anomalyReport.anomalies.length,
                            reviewRecommended: anomalyReport.flagged,
                            fallback: true,
                        },
                    }),
                },
                metadata: {
                    success: false,
                    provider: provider.providerName,
                    payloadSummary: payloadDescription,
                },
            });

            // EU AI Act Art 12 — record the failed invocation too (digest only).
            await logAiDecision(db, ctx, {
                feature: 'risk-suggestions',
                provider: provider.providerName,
                model: null,
                sanitizedInput,
                outputSummary: null,
                latencyMs: Date.now() - aiStart,
                guardVerdict: 'error',
                sessionRef: session.id,
            });

            throw err;
        }

        // AISVS C7.2.2 / C7.3.2 / C7.3.3 / C5.2.4 — output safety gate. Runs
        // here (uniformly over every provider) so the PERSISTED text is already
        // cleaned: system-prompt/instruction leaks redacted, outbound content
        // (URLs / images / HTML) stripped, and below-floor confidence dropped.
        const guard = applyOutputGuard(output);
        const guardedSuggestions = guard.suggestions;

        // AI Guard — egress scan on the model output before it is persisted /
        // surfaced. A secret the model echoed is blocked (never committed) and
        // audited with rule ids only.
        const outputGuard = await guardEgress(ctx, guardedSuggestions, {
            source: 'risk-assessment:output',
            db,
        });
        assertGuardAllowed(outputGuard);

        // AISVS C12.1.3 — one structured inference record per call (carries the
        // C12.1.2 safety-decision block + C12.2.5 token counts). Attached to the
        // generation audit event below.
        const inferenceLog = buildInferenceLog({
            provider: output.provider,
            model: output.modelName,
            outcome: 'success',
            durationMs: Date.now() - aiStart,
            usage: output.usage,
            suggestionCount: guardedSuggestions.length,
            modelMismatch: output.modelMismatch ?? null,
            safety: {
                outputRedactions: guard.redactions,
                droppedLowConfidence: guard.droppedLowConfidence,
                inputAnomalyCount: anomalyReport.anomalies.length,
                reviewRecommended: anomalyReport.flagged,
                fallback: output.isFallback ?? false,
            },
        });

        // AISVS C12 — record the successful AI generation (fallback=true when the
        // provider degraded to the deterministic stub but still returned output).
        recordAiRiskAssessment({
            provider: output.provider,
            outcome: 'success',
            durationMs: Date.now() - aiStart,
            fallback: output.isFallback ?? false,
            suggestionCount: guardedSuggestions.length,
            promptTokens: output.usage?.promptTokens,
            completionTokens: output.usage?.completionTokens,
        });

        // EU AI Act Art 12 — one decision-log row per invocation. Stores a
        // DIGEST of the sanitised input (never the raw prompt/PII) + a bounded
        // summary + latency/cost + the guard verdict. Append-only; the human
        // outcome is stamped later via applySession/dismissSession.
        const guardBlocked = guard.redactions + guard.droppedLowConfidence > 0;
        await logAiDecision(db, ctx, {
            feature: 'risk-suggestions',
            provider: output.provider,
            model: output.modelName,
            sanitizedInput,
            outputSummary: `${guardedSuggestions.length} risk suggestion(s): ${guardedSuggestions.map((s) => s.title).slice(0, 5).join('; ')}`,
            latencyMs: Date.now() - aiStart,
            tokensIn: output.usage?.promptTokens ?? null,
            tokensOut: output.usage?.completionTokens ?? null,
            guardVerdict: guardBlocked ? `redactions=${guard.redactions};dropped=${guard.droppedLowConfidence}` : 'clean',
            guardBlocked,
            sessionRef: session.id,
        });

        // 11. Store suggestion items
        const items = await Promise.all(
            guardedSuggestions.map(async (s) => {
                // Try to find matching asset by name (use original assets for ID lookup)
                const matchedAsset = s.relatedAssetName
                    ? assets.find(a => a.name.toLowerCase() === s.relatedAssetName?.toLowerCase())
                    : undefined;

                return db.riskSuggestionItem.create({
                    data: {
                        sessionId: session.id,
                        tenantId: ctx.tenantId,
                        assetId: matchedAsset?.id ?? null,
                        title: s.title,
                        description: s.description,
                        category: s.category,
                        threat: s.threat,
                        vulnerability: s.vulnerability,
                        likelihoodSuggested: s.likelihood,
                        impactSuggested: s.impact,
                        rationale: s.rationale,
                        suggestedControlsJson: JSON.stringify(s.suggestedControls),
                        status: 'PENDING',
                    },
                });
            })
        );

        // 12. Update session to GENERATED
        const updatedSession = await db.riskSuggestionSession.update({
            where: { id: session.id },
            data: {
                status: 'GENERATED',
                modelName: output.modelName,
                provider: output.provider,
            },
        });

        // 13. Record rate limit usage (after success)
        await recordGeneration(ctx.tenantId, ctx.userId);

        // 14. Audit log with full traceability
        await logEvent(db, ctx, {
            action: 'AI_RISK_SUGGESTIONS_GENERATED',
            entityType: 'RiskSuggestionSession',
            entityId: session.id,
            details: `Generated ${items.length} risk suggestions using ${output.provider}/${output.modelName}. ${output.isFallback ? 'FALLBACK mode (baseline templates).' : 'AI model used.'}`,
            // AISVS C12.1.3 — the structured inference log (provider/model/
            // tokens/latency/outcome + the C12.1.2 safetyDecisions block) ships
            // as structured detailsJson, parseable uniformly by a SIEM.
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'RiskSuggestionSession',
                operation: 'created',
                summary: 'AI_RISK_SUGGESTIONS_GENERATED',
                inferenceLog,
            },
            metadata: {
                success: true,
                provider: output.provider,
                modelName: output.modelName,
                isFallback: output.isFallback ?? false,
                itemCount: items.length,
                // AISVS C7 output-gate signals — how much the model output was
                // scrubbed before it was persisted.
                outputRedactions: guard.redactions,
                droppedLowConfidence: guard.droppedLowConfidence,
                // AISVS C11.4.2 — input anomaly screen result rides the
                // generation record so the draft's provenance shows it.
                inputAnomalyCount: anomalyReport.anomalies.length,
                reviewRecommended: anomalyReport.flagged,
                // AISVS C12.2.5 — token counts for per-tenant attribution.
                promptTokens: output.usage?.promptTokens ?? null,
                completionTokens: output.usage?.completionTokens ?? null,
                totalTokens: output.usage?.totalTokens ?? null,
                frameworks: apiInput.frameworks,
                assetCount: assets.length,
                payloadSummary: payloadDescription,
            },
        });

        // AISVS C11.4.2 — surface the review flag to the caller (API/UI) so a
        // draft generated from anomalous input is presented "review carefully",
        // the human acting as the action gate.
        return {
            session: updatedSession,
            items,
            reviewRecommended:
                anomalyReport.flagged ||
                inputGuard.reviewRequired ||
                outboundGuard.reviewRequired ||
                outputGuard.reviewRequired,
        };
    });
}

// ─── Get Session ───

export async function getSession(ctx: RequestContext, sessionId: string) {
    if (!ctx.permissions.canRead) {
        throw forbidden('Insufficient permissions');
    }

    return runInTenantContext(ctx, async (db) => {
        const session = await db.riskSuggestionSession.findFirst({
            where: { id: sessionId, tenantId: ctx.tenantId },
            include: { items: true },
        });

        if (!session) throw notFound('Session not found');
        return session;
    });
}

// ─── Apply Session (create real Risk records) ───

export async function applySession(ctx: RequestContext, sessionId: string, input: ApplySessionInput) {
    // Feature gate + permission check
    enforceFeatureGate(ctx, 'risk');
    if (!ctx.permissions.canWrite) {
        throw forbidden('Only editors and admins can apply AI risk suggestions');
    }

    const { updatedSession, createdRiskCount } = await runInTenantContext(ctx, async (db) => {
        const session = await db.riskSuggestionSession.findFirst({
            where: { id: sessionId, tenantId: ctx.tenantId },
            include: { items: true },
        });

        if (!session) throw notFound('Session not found');
        if (session.status === 'APPLIED') {
            throw forbidden('Session has already been applied');
        }
        if (session.status === 'DISMISSED') {
            throw forbidden('Session has been dismissed');
        }

        const tenant = await db.tenant.findUnique({ where: { id: ctx.tenantId } });
        const maxScale = tenant?.maxRiskScale ?? 5;

        const acceptedIds = new Set(input.acceptedItemIds);
        const createdRisks: string[] = [];

        for (const item of session.items) {
            if (acceptedIds.has(item.id)) {
                // Check idempotency — skip if risk with same title exists
                const existingRisk = await db.risk.findFirst({
                    where: { tenantId: ctx.tenantId, title: item.title },
                });
                if (existingRisk) {
                    // Mark as accepted but don't create duplicate
                    await db.riskSuggestionItem.update({
                        where: { id: item.id },
                        data: { status: 'ACCEPTED', createdRiskId: existingRisk.id },
                    });
                    createdRisks.push(existingRisk.id);
                    continue;
                }

                const likelihood = item.likelihoodSuggested ?? 3;
                const impact = item.impactSuggested ?? 3;
                const score = Math.round((likelihood / maxScale) * (impact / maxScale) * maxScale * maxScale);

                // Through the repository, NOT db.risk.create — the repo mints
                // the per-tenant RSK-N key from the atomic counter. Creating
                // directly left `key` NULL, so every accepted AI suggestion
                // rendered a blank Code column forever, contradicting
                // risk.prisma's claim that "the create-path generates fresh
                // values for every new row".
                const risk = await RiskRepository.create(db, ctx, {
                    title: item.title,
                    description: item.description,
                    category: item.category,
                    threat: item.threat,
                    vulnerability: item.vulnerability,
                    likelihood,
                    impact,
                    score,
                    inherentScore: score,
                    status: 'OPEN',
                    createdByUserId: ctx.userId,
                });

                // RQ2-7 — accepted AI suggestions land with honest
                // provenance: the inherent anchor is an AI-source
                // ledger event (RQ2-1), not an unattributed write.
                await recordScoreEvent(db, ctx.tenantId, {
                    riskId: risk.id,
                    kind: 'INHERENT',
                    likelihood,
                    impact,
                    score,
                    source: 'AI',
                    justification: item.rationale ?? null,
                    createdByUserId: ctx.userId,
                });

                await db.riskSuggestionItem.update({
                    where: { id: item.id },
                    data: { status: 'ACCEPTED', createdRiskId: risk.id },
                });
                createdRisks.push(risk.id);
            } else {
                // Not in accepted list → mark rejected
                if (item.status === 'PENDING') {
                    await db.riskSuggestionItem.update({
                        where: { id: item.id },
                        data: { status: 'REJECTED' },
                    });
                }
            }
        }

        // Mark session as APPLIED
        const updatedSession = await db.riskSuggestionSession.update({
            where: { id: session.id },
            data: { status: 'APPLIED' },
            include: { items: true },
        });

        // EU AI Act Art 14 — human-oversight outcome on the AI decision.
        await recordDecisionOutcome(db, ctx, session.id, createdRisks.length > 0 ? 'ACCEPTED' : 'REJECTED');

        // Audit log with full traceability
        await logEvent(db, ctx, {
            action: 'AI_RISK_SUGGESTIONS_APPLIED',
            entityType: 'RiskSuggestionSession',
            entityId: session.id,
            details: `Applied ${createdRisks.length} risk suggestions, rejected ${session.items.length - createdRisks.length}`,
            detailsJson: { category: 'custom', event: 'ai_risk_suggestions_applied' },
            metadata: {
                acceptedCount: createdRisks.length,
                rejectedCount: session.items.length - createdRisks.length,
                createdRiskIds: createdRisks,
                sessionProvider: session.provider,
                sessionModel: session.modelName,
            },
        });

        return { updatedSession, createdRiskCount: createdRisks.length };
    });

    // applySession creates/links Risk rows directly (not via the
    // `createRisk` usecase), so it must invalidate the risk list cache
    // itself — every other Risk-mutating usecase in `risk.ts` does the
    // same. Without this, AI-applied risks stay invisible in the Risk
    // Register until the cache TTL expires.
    if (createdRiskCount > 0) {
        await bumpEntityCacheVersion(ctx, 'risk');
    }

    return updatedSession;
}

// ─── Dismiss Session ───

export async function dismissSession(ctx: RequestContext, sessionId: string) {
    // Feature gate + permission check
    enforceFeatureGate(ctx, 'risk');
    if (!ctx.permissions.canWrite) {
        throw forbidden('Only editors and admins can dismiss AI risk suggestions');
    }

    return runInTenantContext(ctx, async (db) => {
        const session = await db.riskSuggestionSession.findFirst({
            where: { id: sessionId, tenantId: ctx.tenantId },
        });

        if (!session) throw notFound('Session not found');

        const updated = await db.riskSuggestionSession.update({
            where: { id: session.id },
            data: { status: 'DISMISSED' },
        });

        // EU AI Act Art 14 — the human rejected the AI suggestions.
        await recordDecisionOutcome(db, ctx, session.id, 'REJECTED');

        // Audit log
        await logEvent(db, ctx, {
            action: 'AI_RISK_SUGGESTIONS_DISMISSED',
            entityType: 'RiskSuggestionSession',
            entityId: session.id,
            details: `Risk suggestion session dismissed. Provider: ${session.provider}, items: ${session.modelName ?? 'unknown'}`,
            detailsJson: { category: 'custom', event: 'ai_risk_suggestions_dismissed' },
            metadata: {
                sessionProvider: session.provider,
                sessionModel: session.modelName,
            },
        });

        return updated;
    });
}
