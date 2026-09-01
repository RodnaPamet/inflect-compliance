/**
 * Canned workflow definitions — the DATA the engine runs (Epic Agentic 1B).
 *
 * `tests/guardrails/canned-workflows-coverage.test.ts` checks the SHAPE of
 * these definitions (registered, declarative, real tool names, a checkpoint
 * before completion). It never CALLS `args` / `buildItems` / `rationale` /
 * `synthesize`, so the whole computed surface of both workflows — the
 * non-string-input fallback, the missing-outputs fallbacks, the 20-item
 * propose cap, the title/section absence branches, and the punch-list's four
 * independent conditions — was unexercised.
 *
 * This file exercises those functions and asserts the VALUES they produce:
 * the tool arguments an engine would send, the candidate items an approval
 * queue would receive, and the summary text a human reads. A regression in
 * any of them (a dropped `?? 0`, a widened slice, a flipped condition)
 * changes a value asserted here.
 */
import { frameworkOnboardingWorkflow } from '@/lib/agentic/workflows/framework-onboarding';
import { auditPrepWorkflow } from '@/lib/agentic/workflows/audit-prep';
import type {
    ProposeStepDef,
    ReadStepDef,
    SynthesisStepDef,
    WorkflowContext,
    WorkflowDefinition,
    WorkflowStepDef,
} from '@/lib/agentic/workflow-types';

// ─── typed step lookup (narrowing, no casts) ─────────────────────────

function stepOf(def: WorkflowDefinition, label: string): WorkflowStepDef {
    const step = def.steps.find((s) => s.label === label);
    if (!step) throw new Error(`${def.key}: no step labelled "${label}"`);
    return step;
}

function readStep(def: WorkflowDefinition, label: string): ReadStepDef {
    const step = stepOf(def, label);
    if (step.kind !== 'READ') {
        throw new Error(`${def.key}.${label} is ${step.kind}, not READ`);
    }
    return step;
}

function proposeStep(def: WorkflowDefinition, label: string): ProposeStepDef {
    const step = stepOf(def, label);
    if (step.kind !== 'PROPOSE') {
        throw new Error(`${def.key}.${label} is ${step.kind}, not PROPOSE`);
    }
    return step;
}

function synthesisStep(def: WorkflowDefinition, label: string): SynthesisStepDef {
    const step = stepOf(def, label);
    if (step.kind !== 'SYNTHESIS') {
        throw new Error(`${def.key}.${label} is ${step.kind}, not SYNTHESIS`);
    }
    return step;
}

function ctx(
    input: Record<string, unknown>,
    outputs: Record<string, unknown> = {},
): WorkflowContext {
    return { input, outputs };
}

/** Build `n` synthetic uncovered requirements (`R-1`, `R-2`, …). */
function unmappedRequirements(n: number): Array<{ code: string }> {
    return Array.from({ length: n }, (_, i) => ({ code: `R-${i + 1}` }));
}

// ─── framework-onboarding ────────────────────────────────────────────

describe('framework-onboarding — READ step arguments', () => {
    it('threads a string frameworkKey into get_framework_status', () => {
        const step = readStep(frameworkOnboardingWorkflow, 'frameworkStatus');
        expect(step.args?.(ctx({ frameworkKey: 'SOC2' }))).toEqual({
            frameworkKey: 'SOC2',
        });
    });

    it('coerces a NON-string frameworkKey to the empty string', () => {
        // A run started with a numeric/object input must not send `42` (or
        // `[object Object]`) to the MCP tool as a framework key.
        const step = readStep(frameworkOnboardingWorkflow, 'frameworkStatus');
        expect(step.args?.(ctx({ frameworkKey: 42 }))).toEqual({ frameworkKey: '' });
        expect(step.args?.(ctx({ frameworkKey: { key: 'SOC2' } }))).toEqual({
            frameworkKey: '',
        });
    });

    it('coerces a MISSING frameworkKey to the empty string', () => {
        const step = readStep(frameworkOnboardingWorkflow, 'frameworkStatus');
        expect(step.args?.(ctx({}))).toEqual({ frameworkKey: '' });
    });

    it('caps the gap query at 50 requirements', () => {
        const step = readStep(frameworkOnboardingWorkflow, 'gaps');
        expect(step.args?.(ctx({ frameworkKey: 'ISO27001' }))).toEqual({
            frameworkKey: 'ISO27001',
            limit: 50,
        });
    });

    it('the tenant-context READ takes no arguments at all', () => {
        const step = readStep(frameworkOnboardingWorkflow, 'tenant');
        expect(step.args).toBeUndefined();
        expect(step.tool).toBe('get_tenant_context');
    });
});

describe('framework-onboarding — proposed control items', () => {
    const step = proposeStep(frameworkOnboardingWorkflow, 'proposedControls');

    it('proposes NOTHING when the gaps read produced no output', () => {
        expect(step.buildItems(ctx({ frameworkKey: 'SOC2' }))).toHaveLength(0);
    });

    it('proposes NOTHING when the gaps output carries no unmappedRequirements', () => {
        expect(
            step.buildItems(
                ctx({ frameworkKey: 'SOC2' }, { gaps: { summary: { total: 10 } } }),
            ),
        ).toHaveLength(0);
    });

    it('builds one candidate control per uncovered requirement, with title + section', () => {
        const items = step.buildItems(
            ctx(
                { frameworkKey: 'SOC2' },
                {
                    gaps: {
                        unmappedRequirements: [
                            { code: 'CC1.1', title: 'Control environment', section: 'CC1' },
                        ],
                    },
                },
            ),
        );

        expect(items).toStrictEqual([
            {
                name: 'CC1.1 — control',
                description: 'Implements requirement CC1.1: Control environment',
                category: 'CC1',
                status: 'NOT_STARTED',
            },
        ]);
    });

    it('omits the title clause and defaults the category when both are absent', () => {
        const items = step.buildItems(
            ctx(
                { frameworkKey: 'SOC2' },
                { gaps: { unmappedRequirements: [{ code: 'CC2.1' }] } },
            ),
        );

        expect(items).toStrictEqual([
            {
                name: 'CC2.1 — control',
                description: 'Implements requirement CC2.1',
                category: 'Onboarding',
                status: 'NOT_STARTED',
            },
        ]);
    });

    it('caps the batch at the propose tool 20-item limit', () => {
        const items = step.buildItems(
            ctx(
                { frameworkKey: 'SOC2' },
                { gaps: { unmappedRequirements: unmappedRequirements(25) } },
            ),
        );

        expect(items).toHaveLength(20);
        // The cap must take the FIRST 20, not a tail slice.
        expect(items[0].name).toBe('R-1 — control');
        expect(items[19].name).toBe('R-20 — control');
    });

    it('names the framework in the rationale the approver reads', () => {
        expect(step.rationale?.(ctx({ frameworkKey: 'NIS2' }))).toBe(
            'Proposed starting controls for the uncovered requirements of NIS2.',
        );
    });
});

describe('framework-onboarding — closing synthesis', () => {
    const step = synthesisStep(frameworkOnboardingWorkflow, 'summary');

    it('reports the proposed count and the gap arithmetic', () => {
        const result = step.synthesize(
            ctx(
                { frameworkKey: 'SOC2' },
                {
                    gaps: { summary: { total: 40, mapped: 31, unmapped: 9 } },
                    proposedControls: { proposed: 9 },
                },
            ),
        );

        expect(result.text).toBe(
            'Onboarded SOC2: proposed 9 controls for review. ' +
                '9 of 40 requirements were uncovered; approving the ' +
                'proposed controls will begin closing those gaps (evidence still required per control).',
        );
        expect(result.data).toEqual({
            frameworkKey: 'SOC2',
            proposedControls: 9,
            totalRequirements: 40,
            uncovered: 9,
        });
    });

    it('degrades to zeroes rather than undefined when every upstream output is missing', () => {
        const result = step.synthesize(ctx({ frameworkKey: 'SOC2' }));

        expect(result.data).toEqual({
            frameworkKey: 'SOC2',
            proposedControls: 0,
            totalRequirements: 0,
            uncovered: 0,
        });
        expect(result.text).toContain('proposed 0 controls for review');
        expect(result.text).toContain('0 of 0 requirements were uncovered');
    });

    it('falls back to zero for a PRESENT summary that omits total/unmapped', () => {
        // Distinct from the missing-summary case below: here `summary` exists,
        // so the optional chain resolves and it is the `?? 0` that has to do
        // the work. A find_coverage_gaps response that reported only `mapped`
        // would otherwise print "undefined of undefined requirements".
        const result = step.synthesize(
            ctx(
                { frameworkKey: 'SOC2' },
                {
                    gaps: { summary: { mapped: 31 } },
                    proposedControls: { proposed: 3 },
                },
            ),
        );

        expect(result.data).toEqual({
            frameworkKey: 'SOC2',
            proposedControls: 3,
            totalRequirements: 0,
            uncovered: 0,
        });
        expect(result.text).toContain('0 of 0 requirements were uncovered');
    });

    it('treats a gaps output with an EMPTY summary as zeroes', () => {
        const result = step.synthesize(
            ctx({ frameworkKey: 'SOC2' }, { gaps: {}, proposedControls: {} }),
        );

        expect(result.data).toEqual({
            frameworkKey: 'SOC2',
            proposedControls: 0,
            totalRequirements: 0,
            uncovered: 0,
        });
    });
});

// ─── audit-prep ──────────────────────────────────────────────────────

describe('audit-prep — READ step arguments', () => {
    it('threads the framework key into status + gaps, and caps gaps at 50', () => {
        expect(
            readStep(auditPrepWorkflow, 'frameworkStatus').args?.(
                ctx({ frameworkKey: 'ISO27001' }),
            ),
        ).toEqual({ frameworkKey: 'ISO27001' });
        expect(
            readStep(auditPrepWorkflow, 'gaps').args?.(ctx({ frameworkKey: 'ISO27001' })),
        ).toEqual({ frameworkKey: 'ISO27001', limit: 50 });
    });

    it('coerces a non-string framework key to the empty string', () => {
        expect(
            readStep(auditPrepWorkflow, 'frameworkStatus').args?.(
                ctx({ frameworkKey: null }),
            ),
        ).toEqual({ frameworkKey: '' });
    });

    it('reads evidence expiring within 30 days and at most 100 findings', () => {
        expect(
            readStep(auditPrepWorkflow, 'expiringEvidence').args?.(ctx({})),
        ).toEqual({ days: 30 });
        expect(readStep(auditPrepWorkflow, 'findings').args?.(ctx({}))).toEqual({
            limit: 100,
        });
    });
});

describe('audit-prep — readiness synthesis', () => {
    const step = synthesisStep(auditPrepWorkflow, 'readiness');

    it('counts array outputs and reports the coverage numbers', () => {
        const result = step.synthesize(
            ctx(
                { frameworkKey: 'SOC2' },
                {
                    gaps: { summary: { coveragePercent: 72, unmapped: 11 } },
                    expiringEvidence: [{ id: 'e1' }, { id: 'e2' }],
                    findings: [{ id: 'f1' }],
                },
            ),
        );

        expect(result.text).toBe(
            'Readiness for SOC2: 72% control coverage, 11 uncovered requirements, ' +
                '2 evidence items expiring, 1 open findings.',
        );
        expect(result.data).toEqual({
            coveragePercent: 72,
            uncovered: 11,
            expiringEvidence: 2,
            openFindings: 1,
        });
    });

    it('counts a NON-array read output as zero rather than throwing', () => {
        // A read tool that returns `{ items: [...] }` (or an error envelope)
        // must not crash the synthesis — it counts as nothing.
        const result = step.synthesize(
            ctx(
                { frameworkKey: 'SOC2' },
                {
                    expiringEvidence: { items: [{ id: 'e1' }] },
                    findings: 'unavailable',
                },
            ),
        );

        expect(result.data).toEqual({
            coveragePercent: 0,
            uncovered: 0,
            expiringEvidence: 0,
            openFindings: 0,
        });
    });

    it('falls back to zero for a PRESENT summary that omits the two figures', () => {
        // `summary` resolves, so the `?? 0` on coveragePercent / unmapped is
        // what keeps "undefined% control coverage" out of the readiness line
        // the auditor reads.
        const result = step.synthesize(
            ctx(
                { frameworkKey: 'SOC2' },
                { gaps: { summary: { total: 40, mapped: 40 } }, findings: [] },
            ),
        );

        expect(result.text).toBe(
            'Readiness for SOC2: 0% control coverage, 0 uncovered requirements, ' +
                '0 evidence items expiring, 0 open findings.',
        );
        expect(result.data).toEqual({
            coveragePercent: 0,
            uncovered: 0,
            expiringEvidence: 0,
            openFindings: 0,
        });
    });

    it('degrades to zeroes when no upstream read produced output', () => {
        const result = step.synthesize(ctx({ frameworkKey: 'SOC2' }));
        expect(result.data).toEqual({
            coveragePercent: 0,
            uncovered: 0,
            expiringEvidence: 0,
            openFindings: 0,
        });
    });
});

describe('audit-prep — proposed findings', () => {
    const step = proposeStep(auditPrepWorkflow, 'proposedFindings');

    it('proposes nothing when there are no uncovered requirements', () => {
        expect(step.buildItems(ctx({ frameworkKey: 'SOC2' }))).toHaveLength(0);
        expect(
            step.buildItems(ctx({ frameworkKey: 'SOC2' }, { gaps: {} })),
        ).toHaveLength(0);
    });

    it('builds a MEDIUM coverage-gap finding, naming the requirement title when present', () => {
        const items = step.buildItems(
            ctx(
                { frameworkKey: 'SOC2' },
                {
                    gaps: {
                        unmappedRequirements: [{ code: 'A.5.1', title: 'Policies' }],
                    },
                },
            ),
        );

        expect(items).toStrictEqual([
            {
                severity: 'MEDIUM',
                type: 'Coverage Gap',
                title: 'Coverage gap: A.5.1',
                description: 'Requirement A.5.1 (Policies) has no mapped control.',
            },
        ]);
    });

    it('omits the parenthetical when the requirement has no title', () => {
        const items = step.buildItems(
            ctx(
                { frameworkKey: 'SOC2' },
                { gaps: { unmappedRequirements: [{ code: 'A.5.2' }] } },
            ),
        );

        expect(items[0].description).toBe(
            'Requirement A.5.2 has no mapped control.',
        );
    });

    it('caps the batch at 20 findings', () => {
        const items = step.buildItems(
            ctx(
                { frameworkKey: 'SOC2' },
                { gaps: { unmappedRequirements: unmappedRequirements(31) } },
            ),
        );
        expect(items).toHaveLength(20);
        expect(items[19].title).toBe('Coverage gap: R-20');
    });

    it('names the framework in the rationale', () => {
        expect(step.rationale?.(ctx({ frameworkKey: 'SOC2' }))).toBe(
            'Material coverage gaps for the SOC2 audit.',
        );
    });
});

describe('audit-prep — drafted policy', () => {
    const step = proposeStep(auditPrepWorkflow, 'draftedPolicies');

    it('drafts exactly one scaffold, keyed to the audited framework', () => {
        const items = step.buildItems(ctx({ frameworkKey: 'ISO27001' }));

        expect(items).toStrictEqual([
            {
                title: 'ISO27001 Information Security Policy',
                description:
                    'Draft policy scaffold for the ISO27001 audit — review and complete.',
                category: 'Audit prep',
                content:
                    '# ISO27001 Information Security Policy\n\n_Draft — complete this before the audit._\n',
            },
        ]);
    });

    it('still drafts one scaffold when the framework key is absent', () => {
        // The draft does not depend on any upstream read, so a missing input
        // degrades the title rather than skipping the step.
        const items = step.buildItems(ctx({}));
        expect(items).toHaveLength(1);
        expect(items[0].title).toBe(' Information Security Policy');
    });

    it('names the framework in the rationale', () => {
        expect(step.rationale?.(ctx({ frameworkKey: 'SOC2' }))).toBe(
            'Draft policy scaffold for the SOC2 audit.',
        );
    });
});

describe('audit-prep — closing report + punch-list', () => {
    const step = synthesisStep(auditPrepWorkflow, 'report');

    it('lists all four actions when every readiness signal is non-zero', () => {
        const result = step.synthesize(
            ctx(
                { frameworkKey: 'SOC2' },
                {
                    readiness: {
                        data: {
                            coveragePercent: 72,
                            uncovered: 11,
                            expiringEvidence: 4,
                            openFindings: 3,
                        },
                    },
                    proposedFindings: { proposed: 11 },
                    draftedPolicies: { proposed: 1 },
                },
            ),
        );

        expect(result.data?.punchList).toStrictEqual([
            'Map controls to 11 uncovered requirements (11 proposed findings).',
            'Refresh 4 expiring evidence items.',
            'Close 3 open findings.',
            'Complete 1 drafted policy(ies).',
        ]);
        expect(result.text).toBe(
            'Audit-readiness report — SOC2: 72% coverage. Punch-list (4): ' +
                'Map controls to 11 uncovered requirements (11 proposed findings). ' +
                'Refresh 4 expiring evidence items. ' +
                'Close 3 open findings. ' +
                'Complete 1 drafted policy(ies).',
        );
    });

    it('DROPS each entry whose signal is zero — an all-clear punch-list is empty', () => {
        const result = step.synthesize(
            ctx(
                { frameworkKey: 'SOC2' },
                {
                    readiness: {
                        data: {
                            coveragePercent: 100,
                            uncovered: 0,
                            expiringEvidence: 0,
                            openFindings: 0,
                        },
                    },
                    proposedFindings: { proposed: 0 },
                    draftedPolicies: { proposed: 0 },
                },
            ),
        );

        // toStrictEqual, not toEqual: `expect([null]).toEqual([])` would not
        // catch a `.filter(Boolean)` that stopped filtering.
        expect(result.data?.punchList).toStrictEqual([]);
        expect(result.text).toBe(
            'Audit-readiness report — SOC2: 100% coverage. Punch-list (0): ',
        );
    });

    it('keeps ONLY the signals that are non-zero', () => {
        const result = step.synthesize(
            ctx(
                { frameworkKey: 'SOC2' },
                {
                    readiness: {
                        data: {
                            coveragePercent: 90,
                            uncovered: 0,
                            expiringEvidence: 2,
                            openFindings: 0,
                        },
                    },
                    draftedPolicies: { proposed: 1 },
                },
            ),
        );

        expect(result.data?.punchList).toStrictEqual([
            'Refresh 2 expiring evidence items.',
            'Complete 1 drafted policy(ies).',
        ]);
    });

    it('reports 0 proposed findings when the propose step produced no output', () => {
        const result = step.synthesize(
            ctx(
                { frameworkKey: 'SOC2' },
                { readiness: { data: { uncovered: 5 } } },
            ),
        );

        expect(result.data?.punchList).toStrictEqual([
            'Map controls to 5 uncovered requirements (0 proposed findings).',
        ]);
    });

    it('degrades to an empty readiness block when the readiness step is missing', () => {
        const result = step.synthesize(ctx({ frameworkKey: 'SOC2' }));

        expect(result.data).toEqual({
            frameworkKey: 'SOC2',
            readiness: {},
            punchList: [],
        });
        expect(result.text).toBe(
            'Audit-readiness report — SOC2: 0% coverage. Punch-list (0): ',
        );
    });

    it('degrades to an empty readiness block when readiness carried no data', () => {
        const result = step.synthesize(
            ctx({ frameworkKey: 'SOC2' }, { readiness: { text: 'no data' } }),
        );
        expect(result.data?.readiness).toEqual({});
    });
});
