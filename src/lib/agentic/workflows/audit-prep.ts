/**
 * Canned workflow — "Audit prep" (Epic Agentic 1B).
 *
 * Turns weeks of manual audit prep into an agent-assembled readiness pack the
 * human refines. Gathers the readiness picture (coverage, gaps, stale evidence,
 * open findings), proposes findings for material gaps + drafts missing policies,
 * pauses for human review, then produces an audit-readiness report + a
 * prioritised punch-list.
 *
 * Input: { frameworkKey } — the framework being audited (e.g. SOC2, ISO27001).
 */
import type { WorkflowDefinition, WorkflowContext } from '../workflow-types';

interface Gaps {
    summary?: { total?: number; mapped?: number; unmapped?: number; coveragePercent?: number };
    unmappedRequirements?: Array<{ code: string; title?: string; section?: string }>;
}

const frameworkKeyOf = (ctx: WorkflowContext): string =>
    typeof ctx.input.frameworkKey === 'string' ? ctx.input.frameworkKey : '';

const arrayLen = (v: unknown): number => (Array.isArray(v) ? v.length : 0);

export const auditPrepWorkflow: WorkflowDefinition = {
    key: 'audit-prep',
    name: 'Audit prep',
    description:
        'Assemble an audit-readiness pack: coverage + gaps + stale evidence + open ' +
        'findings, proposed findings for material gaps and drafted policies, and a ' +
        'prioritised punch-list — for your approval.',
    steps: [
        {
            kind: 'READ', label: 'frameworkStatus', tool: 'get_framework_status',
            args: (ctx) => ({ frameworkKey: frameworkKeyOf(ctx) }),
        },
        {
            kind: 'READ', label: 'gaps', tool: 'find_coverage_gaps',
            args: (ctx) => ({ frameworkKey: frameworkKeyOf(ctx), limit: 50 }),
        },
        { kind: 'READ', label: 'expiringEvidence', tool: 'list_evidence_expiring', args: () => ({ days: 30 }) },
        { kind: 'READ', label: 'findings', tool: 'list_findings', args: () => ({ limit: 100 }) },
        {
            kind: 'SYNTHESIS', label: 'readiness',
            synthesize: (ctx) => {
                const gaps = ctx.outputs['gaps'] as Gaps | undefined;
                const coverage = gaps?.summary?.coveragePercent ?? 0;
                const uncovered = gaps?.summary?.unmapped ?? 0;
                const expiring = arrayLen(ctx.outputs['expiringEvidence']);
                const openFindings = arrayLen(ctx.outputs['findings']);
                return {
                    text: `Readiness for ${frameworkKeyOf(ctx)}: ${coverage}% control coverage, ${uncovered} uncovered requirements, ${expiring} evidence items expiring, ${openFindings} open findings.`,
                    data: { coveragePercent: coverage, uncovered, expiringEvidence: expiring, openFindings },
                };
            },
        },
        {
            kind: 'PROPOSE', label: 'proposedFindings', tool: 'propose_finding',
            buildItems: (ctx) => {
                const gaps = ctx.outputs['gaps'] as Gaps | undefined;
                const unmapped = gaps?.unmappedRequirements ?? [];
                return unmapped.slice(0, 20).map((r) => ({
                    severity: 'MEDIUM',
                    type: 'Coverage Gap',
                    title: `Coverage gap: ${r.code}`,
                    description: r.title ? `Requirement ${r.code} (${r.title}) has no mapped control.` : `Requirement ${r.code} has no mapped control.`,
                }));
            },
            rationale: (ctx) => `Material coverage gaps for the ${frameworkKeyOf(ctx)} audit.`,
        },
        {
            kind: 'PROPOSE', label: 'draftedPolicies', tool: 'draft_policy',
            buildItems: (ctx) => {
                const key = frameworkKeyOf(ctx);
                // Draft a canonical policy for the audited framework — the human
                // completes/replaces it. Kept minimal (a starting draft).
                return [{
                    title: `${key} Information Security Policy`,
                    description: `Draft policy scaffold for the ${key} audit — review and complete.`,
                    category: 'Audit prep',
                    content: `# ${key} Information Security Policy\n\n_Draft — complete this before the audit._\n`,
                }];
            },
            rationale: (ctx) => `Draft policy scaffold for the ${frameworkKeyOf(ctx)} audit.`,
        },
        {
            kind: 'HUMAN_CHECKPOINT', label: 'reviewPack',
            // FIVE DAYS. The pack is an auditor-facing artefact assembled from
            // proposed findings and drafted policies; clearing it means
            // reading them, which is a working-week task rather than an
            // afternoon one. Shorter than the 7 days a proposal gets, because
            // the proposals inside it carry their own deadlines and the pack
            // must not outlive them.
            approvalWindow: '5d',
        },
        {
            kind: 'SYNTHESIS', label: 'report',
            synthesize: (ctx) => {
                const readiness = ctx.outputs['readiness'] as { data?: Record<string, number> } | undefined;
                const d = readiness?.data ?? {};
                const findings = ctx.outputs['proposedFindings'] as { proposed?: number } | undefined;
                const policies = ctx.outputs['draftedPolicies'] as { proposed?: number } | undefined;
                const key = frameworkKeyOf(ctx);
                const punchList = [
                    (d.uncovered ?? 0) > 0 ? `Map controls to ${d.uncovered} uncovered requirements (${findings?.proposed ?? 0} proposed findings).` : null,
                    (d.expiringEvidence ?? 0) > 0 ? `Refresh ${d.expiringEvidence} expiring evidence items.` : null,
                    (d.openFindings ?? 0) > 0 ? `Close ${d.openFindings} open findings.` : null,
                    (policies?.proposed ?? 0) > 0 ? `Complete ${policies?.proposed} drafted policy(ies).` : null,
                ].filter(Boolean);
                return {
                    text:
                        `Audit-readiness report — ${key}: ${d.coveragePercent ?? 0}% coverage. ` +
                        `Punch-list (${punchList.length}): ${punchList.join(' ')}`,
                    data: { frameworkKey: key, readiness: d, punchList },
                };
            },
        },
    ],
};
