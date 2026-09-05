/**
 * Per-agent agentic-risk classification — the rules, in isolation from the DB.
 *
 * Three of these assertions exist because the opposite behaviour is the
 * plausible one, and each would be invisible in a percentage:
 *
 *  • A control linked to ASI01 does NOT make ASI01 covered for an agent whose
 *    AI-system entry was never scoped to ASI01. Drop that conjunction and every
 *    agent in a tenant reports the same numbers — a tenant readout wearing an
 *    agent's name. The `PARTIALLY_COVERED` + `NOT_SCOPED` case below is the one
 *    that fails if somebody "simplifies" it away.
 *
 *  • Inherited coverage is CAPPED at PARTIALLY_COVERED even when the mapping is
 *    EQUAL or SUPERSET, where `determineGapStatus` would return COVERED. A
 *    cross-framework mapping is Inflect's own curated judgement; letting it
 *    mark an agentic risk covered would have the product certify a risk nobody
 *    has looked at, on the strength of a file we wrote.
 *
 *  • A mapping route with no tenant control behind it is structure, not
 *    coverage, and is dropped rather than reported with an empty array — a
 *    populated-looking `inheritedFrom` beside a NOT_COVERED verdict reads as a
 *    bug in the verdict.
 */
import {
    classifyAgentRiskCoverage,
    summariseAgentRiskCoverage,
    type AgentRiskCoverageInput,
    type CoveringControl,
    type InheritedCoverage,
} from '@/app-layer/services/agent-risk-coverage';
import type { MappingStrengthValue } from '@/app-layer/domain/requirement-mapping.types';

const control = (code: string): CoveringControl => ({
    id: `ctl-${code}`,
    code,
    name: `Control ${code}`,
    status: 'IMPLEMENTED',
});

const route = (
    strength: MappingStrengthValue,
    controls: CoveringControl[],
    overrides: Partial<InheritedCoverage> = {},
): InheritedCoverage => ({
    frameworkKey: 'ISO42001-2023',
    frameworkName: 'ISO/IEC 42001:2023',
    requirementCode: 'A.4.2',
    requirementTitle: 'Document an inventory of AI system resources',
    strength,
    controls,
    ...overrides,
});

const risk = (overrides: Partial<AgentRiskCoverageInput> = {}): AgentRiskCoverageInput => ({
    code: 'ASI01',
    title: 'Agent Goal Hijack',
    section: 'ASI01 Agent Goal Hijack',
    scopedToAgent: false,
    directControls: [],
    inheritedFrom: [],
    ...overrides,
});

describe('classifyAgentRiskCoverage — direct coverage needs the agent link', () => {
    it('is COVERED when the agent is scoped to the risk AND a control implements it', () => {
        const entry = classifyAgentRiskCoverage(
            risk({ scopedToAgent: true, directControls: [control('AC-1')] }),
        );
        expect(entry.status).toBe('COVERED');
        expect(entry.reason).toBeNull();
    });

    it('is only PARTIALLY_COVERED when the control exists but the agent was never scoped', () => {
        const entry = classifyAgentRiskCoverage(
            risk({ scopedToAgent: false, directControls: [control('AC-1')] }),
        );
        expect(entry.status).toBe('PARTIALLY_COVERED');
        expect(entry.reason).toBe('NOT_SCOPED');
    });

    it('is NOT_COVERED with NO_CONTROL when the agent is scoped but nothing implements the risk', () => {
        const entry = classifyAgentRiskCoverage(risk({ scopedToAgent: true }));
        expect(entry.status).toBe('NOT_COVERED');
        expect(entry.reason).toBe('NO_CONTROL');
    });

    it('is NOT_COVERED with NOT_SCOPED when neither the scope nor a control exists', () => {
        const entry = classifyAgentRiskCoverage(risk());
        expect(entry.status).toBe('NOT_COVERED');
        expect(entry.reason).toBe('NOT_SCOPED');
    });
});

describe('classifyAgentRiskCoverage — inherited coverage', () => {
    it('lifts a scoped, uncontrolled risk to PARTIALLY_COVERED through an INTERSECT mapping', () => {
        const entry = classifyAgentRiskCoverage(
            risk({ scopedToAgent: true, inheritedFrom: [route('INTERSECT', [control('ISO-1')])] }),
        );
        expect(entry.status).toBe('PARTIALLY_COVERED');
        expect(entry.reason).toBe('NO_CONTROL');
        expect(entry.inheritedFrom.map((i) => i.requirementCode)).toEqual(['A.4.2']);
    });

    it('reports a RELATED-only route as REVIEW_NEEDED, never as coverage', () => {
        const entry = classifyAgentRiskCoverage(
            risk({ scopedToAgent: true, inheritedFrom: [route('RELATED', [control('ISO-1')])] }),
        );
        expect(entry.status).toBe('REVIEW_NEEDED');
    });

    it.each(['EQUAL', 'SUPERSET'] as const)(
        'caps a %s mapping at PARTIALLY_COVERED — a curated mapping never certifies a risk',
        (strength) => {
            const entry = classifyAgentRiskCoverage(
                risk({ scopedToAgent: true, inheritedFrom: [route(strength, [control('ISO-1')])] }),
            );
            expect(entry.status).toBe('PARTIALLY_COVERED');
        },
    );

    it('drops a mapping route that no tenant control stands behind', () => {
        const entry = classifyAgentRiskCoverage(
            risk({ scopedToAgent: true, inheritedFrom: [route('SUPERSET', [])] }),
        );
        expect(entry.inheritedFrom).toEqual([]);
        expect(entry.status).toBe('NOT_COVERED');
    });

    it('keeps the strongest route first so the readout leads with the best evidence', () => {
        const entry = classifyAgentRiskCoverage(
            risk({
                scopedToAgent: true,
                inheritedFrom: [
                    route('RELATED', [control('ISO-A')], { requirementCode: 'A.9.4' }),
                    route('SUBSET', [control('ISO-B')], { requirementCode: 'A.4.2' }),
                    route('INTERSECT', [control('ISO-C')], { requirementCode: 'A.3.2' }),
                ],
            }),
        );
        expect(entry.inheritedFrom.map((i) => i.strength)).toEqual(['SUBSET', 'INTERSECT', 'RELATED']);
    });

    it('never lets inherited coverage outrank a direct, scoped control', () => {
        const entry = classifyAgentRiskCoverage(
            risk({
                scopedToAgent: true,
                directControls: [control('AC-1')],
                inheritedFrom: [route('RELATED', [control('ISO-1')])],
            }),
        );
        expect(entry.status).toBe('COVERED');
    });
});

describe('summariseAgentRiskCoverage', () => {
    const entries = [
        classifyAgentRiskCoverage(risk({ code: 'ASI01', scopedToAgent: true, directControls: [control('A')] })),
        classifyAgentRiskCoverage(risk({ code: 'ASI02', scopedToAgent: true, directControls: [control('B')] })),
        classifyAgentRiskCoverage(risk({ code: 'ASI03', directControls: [control('C')] })),
        classifyAgentRiskCoverage(
            risk({ code: 'ASI04', scopedToAgent: true, inheritedFrom: [route('RELATED', [control('D')])] }),
        ),
        classifyAgentRiskCoverage(risk({ code: 'ASI05', scopedToAgent: true })),
    ];

    it('names WHICH risks sit in each bucket, not just how many', () => {
        const summary = summariseAgentRiskCoverage(entries);
        expect(summary.covered).toEqual(['ASI01', 'ASI02']);
        expect(summary.partiallyCovered).toEqual(['ASI03']);
        expect(summary.reviewNeeded).toEqual(['ASI04']);
        expect(summary.uncovered).toEqual(['ASI05']);
    });

    it('partitions every risk into exactly one bucket', () => {
        const summary = summariseAgentRiskCoverage(entries);
        const all = [
            ...summary.covered,
            ...summary.partiallyCovered,
            ...summary.reviewNeeded,
            ...summary.uncovered,
        ];
        expect(all.length).toBe(summary.total);
        expect(new Set(all).size).toBe(summary.total);
    });

    it('counts only COVERED toward the percentage', () => {
        expect(summariseAgentRiskCoverage(entries).coveragePercent).toBe(40);
    });

    it('reports 0% rather than NaN for a framework with no requirements', () => {
        expect(summariseAgentRiskCoverage([])).toEqual({
            total: 0,
            covered: [],
            partiallyCovered: [],
            reviewNeeded: [],
            uncovered: [],
            coveragePercent: 0,
        });
    });
});
