/**
 * Agent-surface rules scans — the ONLY writer of AgentRuleScan and
 * AgentRuleScanItem.
 *
 * A scanner posts its third signed report, `scanent-agent-rules/1`: what static
 * rules (re-authored from Cisco AI Defense's MCP and skill scanners and the
 * Agent Threat Rules) found written into the MCP tool definitions and the agent
 * skills it read — tool poisoning, prompt injection, an executable payload, an
 * instruction to send data away or to take credentials. The shape is the third-party application ingest's
 * (`third-party-app-scans.ts`), step for step:
 *
 *   1. reads the scanner keys the tenant trusts (unrevoked rows only) — the
 *      SAME keys that sign harness reports, registered under
 *      `admin.agent_registry`;
 *   2. verifies with the contract package's `verifyAndParseAgentRulesReport`
 *      — size, JSON, a signature BY ONE OF THOSE KEYS, the strict `/1` schema —
 *      and writes NOTHING on a refusal. Another contract's report given here is
 *      a SCHEMA refusal;
 *   3. holds the signer to its identity, as the other two ingests do;
 *   4. refuses a replay (`scan.id` is unique per tenant);
 *   5. plans what the report means with the contract's planner
 *      (`planAgentRulesScan`), never a copy of it;
 *   6. writes the scan and one item per finding, and reconciles the findings,
 *      in one transaction.
 *
 * ── WHAT A SCAN CLOSES ──────────────────────────────────────────────────────
 *
 * A finding is created when the plan raises it and none is open, and REOPENED
 * when the plan raises one that was closed. It is RESOLVED only on positive
 * evidence about its ORIGIN (owner decision, 2026-11-22): a later scan by the
 * SAME scanner read the place it was found — an MCP server, a code root — in
 * full (`originsReadInFull`) and did not raise it again. An origin absent from
 * a scan, or read in part, closes nothing — a tool or a skill that was not read
 * is not concluded clean. The origin of a stored finding is read from the items
 * of earlier scans (`AgentRuleScanItem.originRef`); the finding's reference carries the
 * scanner's id (`…@<scannerAgentId>`), so one scanner's read never closes
 * another's finding.
 *
 * A finding is a suggestion a person confirms, never proof: it is an
 * OBSERVATION, its severity is the report's (at most HIGH; a reported `INFO`
 * is stored `LOW`, which `FindingSeverity` has), and it carries no text of the
 * definition, for the report carries none. Findings are written through
 * `FindingRepository` inside the transaction, as the other ingests do, because
 * the principal is a scanner whose key carries `agent_rules_ingest` and
 * nothing else. Every write is sanitised and audited.
 *
 * `tests/guards/agent-harness-single-write-seam.test.ts` refuses a write to the
 * two tables from any other file.
 */
import {
    verifyAndParseAgentRulesReport,
    type AgentRuleFindingCode,
    type AgentRulesReportBody,
} from '@rodnapamet/scanent-contract/agent-rules-contract';
import { originsReadInFull, planAgentRulesScan, type PlannedAgentRuleFinding } from '@rodnapamet/scanent-contract/agent-rules-findings';
import type { Prisma } from '@prisma/client';

import type { RequestContext } from '../types';
import type { PrismaTx } from '@/lib/db-context';
import { runInTenantContext } from '@/lib/db-context';
import { badRequest, conflict, forbidden } from '@/lib/errors/types';
import { mayReadAgentInventory } from '@/lib/permissions';
import { logEvent } from '../events/audit';
import { logger } from '@/lib/observability';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { recordAgentRuleScanOutcome } from '@/lib/observability/integration-metrics';
import { FindingRepository } from '../repositories/FindingRepository';
import { harnessKeyFingerprint, harnessSignedMessage } from '@/lib/agentic/harness-contract';
import { firstSecretShapedMember } from '@/lib/agentic/harness-findings';
import type {
    AgentRuleFindingView,
    AgentRuleInventoryView,
    AgentRuleOutcome,
    AgentRuleSection,
    AgentRuleOriginView,
} from '@/lib/agentic/agent-rule-read-model';

/** `Finding.sourceKind` of every finding this ingest writes. */
export const AGENT_RULE_FINDING_SOURCE_KIND = 'AGENT_RULE';

/** The refusal prefix every refusal carries, for the metric and the caller. */
export const AGENT_RULES_REFUSAL = 'agent_rules_report_refused';

/** How many scanner keys a tenant may hold. The harness ingest's bound. */
const MAX_SCANNER_KEYS = 200;
/** Open findings of one scanner a scan reads to decide what it closes. */
const OPEN_FINDING_CAP = 20_000;

/** Scans the inventory reads, newest `asOf` first: the harness matrix's window. */
export const AGENT_RULE_SCAN_WINDOW = 50;
/** Scanner sections shown, each its latest scan. */
export const MAX_AGENT_RULE_SECTIONS = 3;
/** Open findings shown per section, most severe first. */
export const AGENT_RULE_ROW_CAP = 500;
/** Key holders read to name a scanner with no scan. */
const KEY_HOLDER_CAP = 200;

export interface AgentRuleIngestResult {
    scanId: string;
    scanRef: string;
    complete: boolean;
    findingCount: number;
    findingsOpened: number;
    findingsReopened: number;
    findingsResolved: number;
}

/** What each code means, in the finding's title. Every code has one: a code added without one does not compile. */
const CODE_TITLE: Readonly<Record<AgentRuleFindingCode, string>> = {
    MCP_TOOL_POISONING: 'Possible tool poisoning in an MCP tool definition',
    MCP_PROMPT_INJECTION: 'Possible prompt injection in an MCP tool definition',
    MCP_COMMAND_INJECTION: 'Possible executable payload in an MCP tool definition',
    MCP_DATA_EXFILTRATION: 'Possible data exfiltration instruction in an MCP tool definition',
    MCP_CREDENTIAL_HARVESTING: 'Possible credential harvesting in an MCP tool definition',
    SKILL_PROMPT_INJECTION: 'Possible prompt injection in an agent skill',
    SKILL_COMMAND_INJECTION: 'Possible executable payload in an agent skill',
    SKILL_DATA_EXFILTRATION: 'Possible data exfiltration in an agent skill',
    SKILL_CREDENTIAL_HARVESTING: 'Possible credential harvesting in an agent skill',
    SKILL_EXCESSIVE_PERMISSION: 'Possible excessive permission in an agent skill',
    SKILL_IMPERSONATION: 'Possible impersonation in an agent skill',
};

/** Where a person opens the subject to judge a finding, by the subject's kind. */
const WHERE_TO_JUDGE: Readonly<Record<PlannedAgentRuleFinding['subjectKind'], string>> = {
    'mcp-tool': "open the tool's definition on its server",
    skill: "open the skill's SKILL.md",
    'skill-file': 'open the script in the skill',
};

const SEVERITY_ORDER: Readonly<Record<string, number>> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

function assertMayIngest(ctx: RequestContext): void {
    if (!ctx.appPermissions.admin.agent_rules_ingest) {
        throw forbidden('Submitting an agent-surface rules scan requires admin.agent_rules_ingest');
    }
}

/** Reading the scans is reading the agent inventory, as the harness tab's is (#3710). */
function assertMayRead(ctx: RequestContext): void {
    if (!mayReadAgentInventory(ctx.appPermissions.admin)) {
        throw forbidden('Reading agent-surface rules scans requires admin.agent_registry_view');
    }
}

const refused = (code: string, detail?: string) =>
    badRequest(`${AGENT_RULES_REFUSAL}: ${code}${detail ? `: ${detail}` : ''}`);

/** A finding about a tool is the scanner's: the planner's reference, scoped to the scanner. */
export function agentRuleFindingSourceRef(plannerRef: string, scannerAgentId: string): string {
    return `${plannerRef}@${scannerAgentId}`;
}

/** The report's severity as a `FindingSeverity`: it has no INFO, so INFO is LOW. */
export function findingSeverityOf(severity: string): 'LOW' | 'MEDIUM' | 'HIGH' {
    return severity === 'HIGH' ? 'HIGH' : severity === 'MEDIUM' ? 'MEDIUM' : 'LOW';
}

/** The field a locator names: `description` or `inputSchema`. */
function fieldOf(locator: string): string {
    const hash = locator.lastIndexOf('#');
    return hash < 0 ? '' : locator.slice(hash + 1);
}

/** Verify, plan and record one signed `scanent-agent-rules/1` report. */
export async function ingestAgentRuleReport(ctx: RequestContext, raw: string): Promise<AgentRuleIngestResult> {
    assertMayIngest(ctx);

    try {
        const result = await runInTenantContext(ctx, async (db) => {
            const keys = await db.agentHarnessScannerKey.findMany({
                where: { tenantId: ctx.tenantId, revokedAt: null },
                select: { id: true, agentId: true, publicKey: true, keyFingerprint: true },
                take: MAX_SCANNER_KEYS,
            });

            // Verification first; nothing below reads the body before it has
            // passed a key the tenant trusts and the strict schema.
            const verdict = verifyAndParseAgentRulesReport(raw, keys.map((k) => k.publicKey));
            if (!verdict.ok) {
                throw refused(verdict.reason, verdict.issues ? verdict.issues.slice(0, 20).join('; ') : undefined);
            }
            const body = verdict.body;
            // The schema refuses a secret in a ref and a locator; the ingest walks
            // every other string too, as the other ingests do. Named by path only.
            const secretAt = firstSecretShapedMember(body);
            if (secretAt) throw refused('SECRET_IN_REPORT', secretAt);
            const fingerprint = harnessKeyFingerprint(verdict.signerKey);
            const key = keys.find((k) => k.keyFingerprint === fingerprint);
            if (!key) throw refused('UNTRUSTED_SIGNER');

            if (body.scan.scanner.agentId !== key.agentId) {
                throw refused(
                    'SCANNER_MISMATCH',
                    'the report names a scanner other than the registered agent this signing key belongs to',
                );
            }
            if (ctx.agentId && ctx.agentId !== key.agentId) {
                throw forbidden(
                    `${AGENT_RULES_REFUSAL}: SUBMITTER_MISMATCH: this credential is bound to a different `
                    + 'agent from the scanner that signed the report',
                );
            }

            const replay = await db.agentRuleScan.findFirst({
                where: { tenantId: ctx.tenantId, scanRef: body.scan.id },
                select: { id: true },
            });
            if (replay) throw conflict(`${AGENT_RULES_REFUSAL}: REPLAY: scan ${body.scan.id} is already ingested`);

            return record(db, ctx, body, key.id, verdict.complete, raw);
        });
        recordAgentRuleScanOutcome({ outcome: 'ingested', complete: result.complete, empty: result.subjects === 0 });
        const { subjects: _subjects, ...answer } = result;
        return answer;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const reason = new RegExp(`${AGENT_RULES_REFUSAL}: ([A-Z_]+)`).exec(message)?.[1] ?? 'ERROR';
        recordAgentRuleScanOutcome({ outcome: 'refused', reason });
        // The reason code only: a refused report's content is untrusted.
        logger.warn('agent-surface rules scan refused', { component: 'agent-rule-scans', reason });
        throw err;
    }
}

interface PlannedWrite {
    readonly code: AgentRuleFindingCode;
    readonly sourceRef: string;
    readonly severity: 'LOW' | 'MEDIUM' | 'HIGH';
    readonly title: string;
    readonly description: string;
}

function plannedWrite(f: PlannedAgentRuleFinding, scannerAgentId: string): PlannedWrite {
    return {
        code: f.code,
        sourceRef: agentRuleFindingSourceRef(f.sourceRef, scannerAgentId),
        severity: findingSeverityOf(f.severity),
        title: CODE_TITLE[f.code],
        description:
            `The rule ${f.ruleId} fired on the ${fieldOf(f.locator)} of ${f.subjectKindTitle.toLowerCase()} ${f.subjectRef}, `
            + `read from ${f.originRef}. A rule match is a suggestion for a person to confirm, not proof: `
            + `${WHERE_TO_JUDGE[f.subjectKind]} and judge it. The scanner kept no text of it.`,
    };
}

async function record(
    db: PrismaTx,
    ctx: RequestContext,
    body: AgentRulesReportBody,
    scannerKeyId: string,
    complete: boolean,
    raw: string,
): Promise<AgentRuleIngestResult & { subjects: number }> {
    const now = new Date();
    const scannerAgentId = body.scan.scanner.agentId;
    const plan = planAgentRulesScan(body);
    const parsed = JSON.parse(raw) as { signature: { sig: string } };
    const reportDigest = harnessSignedMessage(body).toString('hex');

    // One write per finding reference: a report naming the same rule on the same field twice raises it once.
    const assert: PlannedWrite[] = [];
    const itemRows: { sourceRef: string; f: PlannedAgentRuleFinding }[] = [];
    const seen = new Set<string>();
    for (const f of plan.findings) {
        const w = plannedWrite(f, scannerAgentId);
        if (seen.has(w.sourceRef)) continue;
        seen.add(w.sourceRef);
        assert.push(w);
        itemRows.push({ sourceRef: w.sourceRef, f });
    }

    const scan = await db.agentRuleScan.create({
        data: {
            tenantId: ctx.tenantId,
            scanRef: body.scan.id,
            scannerAgentId,
            scannerKeyId,
            scannerVersion: body.scan.scanner.version,
            scannerManifestHash: body.scan.scanner.manifestHash,
            asOf: new Date(body.scan.asOf),
            reportDigest,
            signature: parsed.signature.sig,
            complete,
            outcome: plan.outcome,
            populationJson: body.population as unknown as Prisma.InputJsonValue,
            originsJson: body.origins as unknown as Prisma.InputJsonValue,
            subjects: plan.subjects,
            flagged: plan.flagged,
            findingCount: assert.length,
        },
        select: { id: true, scanRef: true, complete: true, reportDigest: true },
    });

    if (itemRows.length > 0) {
        await db.agentRuleScanItem.createMany({
            data: itemRows.map(({ sourceRef, f }) => ({
                tenantId: ctx.tenantId,
                scanId: scan.id,
                sourceRef,
                originRef: f.originRef,
                code: f.code,
                ruleId: f.ruleId,
                severity: f.severity,
                subjectRef: f.subjectRef,
                locator: f.locator,
            })),
        });
    }

    // ── What this scan may close: this scanner's open findings from an origin it read in full ──
    const readInFull = originsReadInFull(body);
    const asserted = new Set(assert.map((f) => f.sourceRef));
    const resolve: string[] = [];
    if (readInFull.size > 0) {
        const open = await db.finding.findMany({
            where: {
                tenantId: ctx.tenantId,
                sourceKind: AGENT_RULE_FINDING_SOURCE_KIND,
                sourceRef: { endsWith: `@${scannerAgentId}` },
                status: { not: 'CLOSED' },
                deletedAt: null,
            },
            select: { sourceRef: true },
            orderBy: { createdAt: 'asc' },
            take: OPEN_FINDING_CAP,
        });
        const candidates = [...new Set(open.map((f) => f.sourceRef).filter((r): r is string => r !== null && !asserted.has(r)))];
        if (candidates.length > 0) {
            // A reference names one field of one subject at one origin, so every item of it names the same origin.
            const origins = await db.agentRuleScanItem.groupBy({
                by: ['sourceRef', 'originRef'],
                where: { tenantId: ctx.tenantId, sourceRef: { in: candidates } },
            });
            for (const o of origins) if (readInFull.has(o.originRef)) resolve.push(o.sourceRef);
        }
    }

    const counts = await reconcileFindings(db, ctx, scan, assert, [...new Set(resolve)], now);

    await logEvent(db, ctx, {
        action: 'AGENT_RULE_SCAN_INGESTED',
        entityType: 'AgentRuleScan',
        entityId: scan.id,
        details: `Ingested agent-surface rules scan ${scan.scanRef} (${plan.subjects} tool definitions, ${assert.length} findings)`,
        detailsJson: {
            category: 'custom',
            entityName: 'AgentRuleScan',
            operation: 'ingested',
            after: {
                scanRef: scan.scanRef,
                scannerAgentId,
                complete: scan.complete,
                outcome: plan.outcome,
                subjects: plan.subjects,
                flagged: plan.flagged,
                originCount: body.origins.length,
                originsReadInFull: readInFull.size,
                findingCount: assert.length,
                reportDigest: scan.reportDigest,
                findingsOpened: counts.findingsOpened,
                findingsReopened: counts.findingsReopened,
                findingsResolved: counts.findingsResolved,
            },
        },
    });

    return {
        scanId: scan.id,
        scanRef: scan.scanRef,
        complete: scan.complete,
        findingCount: assert.length,
        subjects: plan.subjects,
        ...counts,
    };
}

async function reconcileFindings(
    db: PrismaTx,
    ctx: RequestContext,
    scan: { scanRef: string },
    assert: readonly PlannedWrite[],
    resolve: readonly string[],
    now: Date,
): Promise<{ findingsOpened: number; findingsReopened: number; findingsResolved: number }> {
    const refs = [...new Set([...assert.map((f) => f.sourceRef), ...resolve])];
    const existing = refs.length === 0
        ? []
        : await db.finding.findMany({
            where: {
                tenantId: ctx.tenantId,
                sourceKind: AGENT_RULE_FINDING_SOURCE_KIND,
                sourceRef: { in: refs },
                deletedAt: null,
            },
            select: { id: true, sourceRef: true, status: true },
            orderBy: { createdAt: 'asc' },
            take: refs.length,
        });
    const byRef = new Map<string, (typeof existing)[number]>();
    for (const f of existing) if (f.sourceRef && !byRef.has(f.sourceRef)) byRef.set(f.sourceRef, f);

    let findingsOpened = 0;
    let findingsReopened = 0;
    let findingsResolved = 0;

    for (const f of assert) {
        const prior = byRef.get(f.sourceRef);
        if (!prior) {
            const created = await FindingRepository.create(db, ctx, {
                severity: f.severity,
                type: 'OBSERVATION',
                title: sanitizePlainText(f.title),
                description: sanitizePlainText(f.description),
                status: 'OPEN',
                sourceKind: AGENT_RULE_FINDING_SOURCE_KIND,
                sourceRef: f.sourceRef,
            });
            findingsOpened += 1;
            await logEvent(db, ctx, {
                action: 'CREATE',
                entityType: 'Finding',
                entityId: created.id,
                details: `Agent-surface rules scan ${scan.scanRef} raised ${f.code}`,
                detailsJson: {
                    category: 'entity_lifecycle',
                    entityName: 'Finding',
                    operation: 'created',
                    after: { code: f.code, sourceRef: f.sourceRef, severity: f.severity, scanRef: scan.scanRef },
                },
            });
        } else if (prior.status === 'CLOSED') {
            await db.finding.update({
                where: { id: prior.id },
                data: {
                    status: 'OPEN',
                    verificationNotes: sanitizePlainText(`Reopened by agent-surface rules scan ${scan.scanRef}`),
                },
            });
            findingsReopened += 1;
            await logEvent(db, ctx, {
                action: 'STATUS_CHANGE',
                entityType: 'Finding',
                entityId: prior.id,
                details: `Agent-surface rules scan ${scan.scanRef} reopened ${f.code}`,
                detailsJson: {
                    category: 'status_change',
                    entityName: 'Finding',
                    before: { status: 'CLOSED' },
                    after: { status: 'OPEN', sourceRef: f.sourceRef, scanRef: scan.scanRef },
                },
            });
        }
    }

    for (const ref of resolve) {
        const prior = byRef.get(ref);
        if (!prior || prior.status === 'CLOSED') continue;
        await db.finding.update({
            where: { id: prior.id },
            data: {
                status: 'CLOSED',
                verifiedAt: now,
                verificationNotes: sanitizePlainText(
                    `Resolved by agent-surface rules scan ${scan.scanRef}: the same scanner read the place it was found in full and the rule did not fire again`,
                ),
            },
        });
        findingsResolved += 1;
        await logEvent(db, ctx, {
            action: 'STATUS_CHANGE',
            entityType: 'Finding',
            entityId: prior.id,
            details: `Agent-surface rules scan ${scan.scanRef} resolved ${ref}`,
            detailsJson: {
                category: 'status_change',
                entityName: 'Finding',
                before: { status: prior.status },
                after: { status: 'CLOSED', sourceRef: ref, scanRef: scan.scanRef },
            },
        });
    }

    return { findingsOpened, findingsReopened, findingsResolved };
}

const SCAN_ORDER = [{ asOf: 'desc' as const }, { createdAt: 'desc' as const }, { id: 'desc' as const }];

/** The most recent scans, newest first by the moment they describe, then arrival, then id. */
export async function listAgentRuleScans(ctx: RequestContext, opts: { take?: number } = {}) {
    assertMayRead(ctx);
    const take = Math.min(Math.max(opts.take ?? 50, 1), 200);
    return runInTenantContext(ctx, (db) =>
        db.agentRuleScan.findMany({
            where: { tenantId: ctx.tenantId },
            orderBy: SCAN_ORDER,
            take,
            select: {
                id: true,
                scanRef: true,
                scannerAgentId: true,
                scannerVersion: true,
                asOf: true,
                complete: true,
                outcome: true,
                subjects: true,
                flagged: true,
                findingCount: true,
                originsJson: true,
                createdAt: true,
            },
        }),
    );
}

// ─── The inventory read ─────────────────────────────────────────────────────

function originsOf(json: unknown): AgentRuleOriginView[] {
    if (!Array.isArray(json)) return [];
    const out: AgentRuleOriginView[] = [];
    for (const o of json) {
        if (!o || typeof o !== 'object') continue;
        const { ref, status, reason, subjects } = o as Record<string, unknown>;
        if (typeof ref !== 'string' || (status !== 'COMPLETE' && status !== 'INCOMPLETE') || typeof subjects !== 'number') continue;
        out.push({ ref, status, reason: typeof reason === 'string' ? reason : null, subjects });
    }
    return out;
}

function incompleteReasonOf(json: unknown): string | null {
    if (!Array.isArray(json)) return null;
    for (const p of json) {
        if (p && typeof p === 'object' && (p as { status?: unknown }).status === 'INCOMPLETE') {
            const reason = (p as { reason?: unknown }).reason;
            return typeof reason === 'string' ? reason : 'INCOMPLETE';
        }
    }
    return null;
}

const OUTCOMES: readonly AgentRuleOutcome[] = ['FINDINGS', 'NO_FINDING_ON_A_COMPLETE_READ', 'NOTHING_READ', 'NOT_CONCLUDED'];

/**
 * The Agent surface tab's read: each trusted scanner's LATEST scan (by `asOf`,
 * then arrival, then id), the origins it read, and the scanner's open
 * agent-rule findings, most severe first.
 *
 * Read under the inventory rule, as the harness tab is. Writes nothing. An
 * empty population is never rendered as an empty state: no scan, a read of
 * nothing and a trusted scanner with no scan are each a stated condition.
 */
export async function getAgentRuleInventory(
    ctx: RequestContext,
    opts: { scanWindow?: number; rowCap?: number } = {},
): Promise<AgentRuleInventoryView> {
    assertMayRead(ctx);
    const window = Math.min(Math.max(opts.scanWindow ?? AGENT_RULE_SCAN_WINDOW, 1), AGENT_RULE_SCAN_WINDOW);
    const rowCap = Math.min(Math.max(opts.rowCap ?? AGENT_RULE_ROW_CAP, 1), AGENT_RULE_ROW_CAP);

    return runInTenantContext(ctx, async (db) => {
        const listed = await db.agentRuleScan.findMany({
            where: { tenantId: ctx.tenantId },
            orderBy: SCAN_ORDER,
            take: window + 1,
            select: {
                id: true,
                scanRef: true,
                scannerAgentId: true,
                scannerVersion: true,
                asOf: true,
                complete: true,
                outcome: true,
                subjects: true,
                flagged: true,
                findingCount: true,
                populationJson: true,
                originsJson: true,
            },
        });
        const scansTruncated = listed.length > window;
        const scanned = listed.slice(0, window);

        const latestByScanner = new Map<string, (typeof scanned)[number]>();
        for (const s of scanned) if (!latestByScanner.has(s.scannerAgentId)) latestByScanner.set(s.scannerAgentId, s);
        const shown = [...latestByScanner.values()].slice(0, MAX_AGENT_RULE_SECTIONS);
        const scannersNotShown = latestByScanner.size - shown.length;

        const keyHolders = await db.agentHarnessScannerKey.findMany({
            where: { tenantId: ctx.tenantId, revokedAt: null },
            select: { agentId: true },
            distinct: ['agentId'],
            orderBy: { agentId: 'asc' },
            take: KEY_HOLDER_CAP,
        });
        const withoutScanIds = keyHolders.map((k) => k.agentId).filter((id) => !latestByScanner.has(id));

        const agentIds = [...new Set([...shown.map((s) => s.scannerAgentId), ...withoutScanIds])];
        const agents = agentIds.length === 0
            ? []
            : await db.registeredAgent.findMany({
                where: { tenantId: ctx.tenantId, id: { in: agentIds } },
                select: { id: true, name: true, deletedAt: true },
                take: agentIds.length,
            });
        const nameOf = new Map(agents.map((a) => [a.id, a.deletedAt === null ? a.name : null]));

        // One read of the open agent-rule findings, split by the scanner each reference names.
        const open = shown.length === 0
            ? []
            : await db.finding.findMany({
                where: {
                    tenantId: ctx.tenantId,
                    sourceKind: AGENT_RULE_FINDING_SOURCE_KIND,
                    status: { not: 'CLOSED' },
                    deletedAt: null,
                },
                select: { id: true, sourceRef: true, severity: true },
                orderBy: { createdAt: 'asc' },
                take: OPEN_FINDING_CAP + 1,
            });
        const openTruncated = open.length > OPEN_FINDING_CAP;
        const openByScanner = new Map<string, (typeof open)[number][]>();
        for (const f of open.slice(0, OPEN_FINDING_CAP)) {
            if (!f.sourceRef) continue;
            const at = f.sourceRef.lastIndexOf('@');
            if (at < 0) continue;
            const scanner = f.sourceRef.slice(at + 1);
            const list = openByScanner.get(scanner) ?? [];
            list.push(f);
            openByScanner.set(scanner, list);
        }
        const shownOpen = shown.map((s) => (openByScanner.get(s.scannerAgentId) ?? []));
        const refs = [...new Set(shownOpen.flatMap((list) => list.slice(0, rowCap).map((f) => f.sourceRef as string)))];
        const items = refs.length === 0
            ? []
            : await db.agentRuleScanItem.groupBy({
                by: ['sourceRef', 'originRef', 'code', 'ruleId', 'subjectRef', 'locator'],
                where: { tenantId: ctx.tenantId, sourceRef: { in: refs } },
            });
        const itemOf = new Map(items.map((i) => [i.sourceRef, i]));

        const sections: AgentRuleSection[] = shown.map((s, k) => {
            const all = shownOpen[k];
            const findings: AgentRuleFindingView[] = [];
            for (const f of all.slice(0, rowCap)) {
                const item = itemOf.get(f.sourceRef as string);
                if (!item) continue;
                findings.push({
                    findingId: f.id,
                    code: item.code,
                    ruleId: item.ruleId,
                    severity: f.severity,
                    originRef: item.originRef,
                    subjectRef: item.subjectRef,
                    locator: item.locator,
                    field: fieldOf(item.locator),
                });
            }
            findings.sort(
                (a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9) || (a.locator < b.locator ? -1 : a.locator > b.locator ? 1 : 0),
            );
            return {
                scannerAgentId: s.scannerAgentId,
                scannerName: nameOf.get(s.scannerAgentId) ?? null,
                scan: {
                    scanRef: s.scanRef,
                    asOf: s.asOf.toISOString(),
                    scannerVersion: s.scannerVersion,
                    complete: s.complete,
                    outcome: (OUTCOMES as readonly string[]).includes(s.outcome) ? (s.outcome as AgentRuleOutcome) : 'NOT_CONCLUDED',
                    subjects: s.subjects,
                    flagged: s.flagged,
                    findingCount: s.findingCount,
                    incompleteReason: incompleteReasonOf(s.populationJson),
                },
                origins: originsOf(s.originsJson),
                findings,
                findingsTruncated: openTruncated || all.length > rowCap,
            };
        });

        return {
            sections,
            scannersWithoutScan: withoutScanIds.map((id) => ({ agentId: id, name: nameOf.get(id) ?? null })),
            scannersNotShown,
            scansTruncated,
        };
    });
}
