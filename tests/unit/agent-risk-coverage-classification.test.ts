/**
 * Per-agent agentic-risk classification — the rules, in isolation from the DB.
 *
 * Three of these assertions exist because the opposite behaviour is the
 * plausible one, and each would be invisible in a percentage:
 *
 *  • A risk the agent's exposure profile puts out of scope short-circuits to
 *    NOT_APPLICABLE and leaves the percentage's denominator, even when a
 *    control implements it. This replaces the retired claim that a control
 *    linked to ASI01 did not cover ASI01 for an agent whose AI-system entry was
 *    never scoped: that conjunction WAS the per-agent term, and it was
 *    unsatisfiable — nothing in the product writes an `AiSystemRequirementLink`
 *    onto an ASI requirement, so COVERED was unreachable and every risk read
 *    "not scoped" for every agent. The CONSTRAINT it existed for is unchanged
 *    and is now carried by `applicability`: drop that term and every agent in
 *    a tenant reports the same numbers again — a tenant readout wearing an
 *    agent's name.
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
import {
    APPLIES,
    type ApplicabilityBasis,
} from '@/app-layer/services/agent-risk-applicability';
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
    applicability: APPLIES,
    explicitlyScoped: false,
    directControls: [],
    inheritedFrom: [],
    ...overrides,
});

/** A risk the register puts out of scope, with the column that says so. */
const notApplicable = (basis: ApplicabilityBasis = 'NO_TOOL_GRANTS') =>
    ({ applicable: false, basis }) as const;

describe('classifyAgentRiskCoverage — direct coverage needs the risk to apply', () => {
    it('is COVERED when the risk applies AND a control implements it', () => {
        const entry = classifyAgentRiskCoverage(risk({ directControls: [control('AC-1')] }));
        expect(entry.status).toBe('COVERED');
        expect(entry.reason).toBeNull();
        expect(entry.applicabilityBasis).toBeNull();
    });

    it('is COVERED whether or not an operator ALSO recorded the scope explicitly', () => {
        // `explicitlyScoped` is informational by the time a row reaches here:
        // the query layer folds an operator override into `applicability`
        // before classification, so it must not act as a second gate.
        const derived = classifyAgentRiskCoverage(risk({ directControls: [control('AC-1')] }));
        const recorded = classifyAgentRiskCoverage(
            risk({ explicitlyScoped: true, directControls: [control('AC-1')] }),
        );
        expect(recorded.status).toBe(derived.status);
    });

    it('is NOT_COVERED with NO_CONTROL when the risk applies but nothing implements it', () => {
        const entry = classifyAgentRiskCoverage(risk());
        expect(entry.status).toBe('NOT_COVERED');
        expect(entry.reason).toBe('NO_CONTROL');
    });
});

describe('classifyAgentRiskCoverage — inherited coverage', () => {
    it('lifts a scoped, uncontrolled risk to PARTIALLY_COVERED through an INTERSECT mapping', () => {
        const entry = classifyAgentRiskCoverage(
            risk({ inheritedFrom: [route('INTERSECT', [control('ISO-1')])] }),
        );
        expect(entry.status).toBe('PARTIALLY_COVERED');
        expect(entry.reason).toBe('NO_CONTROL');
        expect(entry.inheritedFrom.map((i) => i.requirementCode)).toEqual(['A.4.2']);
    });

    it('reports a RELATED-only route as REVIEW_NEEDED, never as coverage', () => {
        const entry = classifyAgentRiskCoverage(
            risk({ inheritedFrom: [route('RELATED', [control('ISO-1')])] }),
        );
        expect(entry.status).toBe('REVIEW_NEEDED');
    });

    it.each(['EQUAL', 'SUPERSET'] as const)(
        'caps a %s mapping at PARTIALLY_COVERED — a curated mapping never certifies a risk',
        (strength) => {
            const entry = classifyAgentRiskCoverage(
                risk({ inheritedFrom: [route(strength, [control('ISO-1')])] }),
            );
            expect(entry.status).toBe('PARTIALLY_COVERED');
        },
    );

    it('drops a mapping route that no tenant control stands behind', () => {
        const entry = classifyAgentRiskCoverage(
            risk({ inheritedFrom: [route('SUPERSET', [])] }),
        );
        expect(entry.inheritedFrom).toEqual([]);
        expect(entry.status).toBe('NOT_COVERED');
    });

    it('keeps the strongest route first so the readout leads with the best evidence', () => {
        const entry = classifyAgentRiskCoverage(
            risk({
                inheritedFrom: [
                    route('RELATED', [control('ISO-A')], { requirementCode: 'A.9.4' }),
                    route('SUBSET', [control('ISO-B')], { requirementCode: 'A.4.2' }),
                    route('INTERSECT', [control('ISO-C')], { requirementCode: 'A.3.2' }),
                ],
            }),
        );
        expect(entry.inheritedFrom.map((i) => i.strength)).toEqual(['SUBSET', 'INTERSECT', 'RELATED']);
    });

    it('never lets inherited coverage outrank a direct control', () => {
        const entry = classifyAgentRiskCoverage(
            risk({
                directControls: [control('AC-1')],
                inheritedFrom: [route('RELATED', [control('ISO-1')])],
            }),
        );
        expect(entry.status).toBe('COVERED');
    });
});

describe('summariseAgentRiskCoverage', () => {
    // ASI03 reaches PARTIALLY_COVERED through an INHERITED route, which is now
    // the only route to it: a direct control on an applicable risk is COVERED,
    // and the old fixture's "controlled but never scoped" partial is no longer
    // a state the classifier can produce. All five apply, so `applicableTotal`
    // is 5 and the percentage is the same 40 — the arithmetic did not move,
    // the input shape did.
    const entries = [
        classifyAgentRiskCoverage(risk({ code: 'ASI01', directControls: [control('A')] })),
        classifyAgentRiskCoverage(risk({ code: 'ASI02', directControls: [control('B')] })),
        classifyAgentRiskCoverage(
            risk({ code: 'ASI03', inheritedFrom: [route('EQUAL', [control('C')])] }),
        ),
        classifyAgentRiskCoverage(
            risk({ code: 'ASI04', inheritedFrom: [route('RELATED', [control('D')])] }),
        ),
        classifyAgentRiskCoverage(risk({ code: 'ASI05' })),
    ];

    it('names WHICH risks sit in each bucket, not just how many', () => {
        const summary = summariseAgentRiskCoverage(entries);
        expect(summary.covered).toEqual(['ASI01', 'ASI02']);
        expect(summary.partiallyCovered).toEqual(['ASI03']);
        expect(summary.reviewNeeded).toEqual(['ASI04']);
        expect(summary.uncovered).toEqual(['ASI05']);
        expect(summary.notApplicable).toEqual([]);
    });

    it('partitions every risk into exactly one of the FIVE buckets', () => {
        const summary = summariseAgentRiskCoverage([
            ...entries,
            classifyAgentRiskCoverage(risk({ code: 'ASI06', applicability: notApplicable() })),
        ]);
        const all = [
            ...summary.covered,
            ...summary.partiallyCovered,
            ...summary.reviewNeeded,
            ...summary.uncovered,
            ...summary.notApplicable,
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
            applicableTotal: 0,
            covered: [],
            partiallyCovered: [],
            reviewNeeded: [],
            uncovered: [],
            notApplicable: [],
            coveragePercent: 0,
        });
    });
});

describe('classifyAgentRiskCoverage — applicability', () => {
    it('short-circuits to NOT_APPLICABLE even when a direct control implements the risk', () => {
        // The control is real and the tenant holds it; it just does not make a
        // risk apply. Getting this backwards would let a tenant-wide control
        // drag a risk the register excused back into the covered count, and
        // the percentage would climb for an agent nobody changed.
        const entry = classifyAgentRiskCoverage(
            risk({ applicability: notApplicable(), directControls: [control('AC-1')] }),
        );
        expect(entry.status).toBe('NOT_APPLICABLE');
        expect(entry.reason).toBe('NOT_APPLICABLE');
        expect(entry.applicabilityBasis).toBe('NO_TOOL_GRANTS');
    });

    it('carries the basis through verbatim, so the UI can name the register column', () => {
        const entry = classifyAgentRiskCoverage(
            risk({ code: 'ASI08', applicability: notApplicable('SUGGEST_ONLY') }),
        );
        expect(entry.applicabilityBasis).toBe('SUGGEST_ONLY');
    });

    it('still reports the inherited routes behind an N/A risk, sorted and pruned', () => {
        // The routes are a fact either way, and showing them is what lets a
        // reader argue with the applicability call instead of taking it on
        // trust. The control-less route is still dropped.
        const entry = classifyAgentRiskCoverage(
            risk({
                applicability: notApplicable(),
                inheritedFrom: [
                    route('RELATED', [control('ISO-A')], { requirementCode: 'A.9.4' }),
                    route('SUBSET', [control('ISO-B')], { requirementCode: 'A.4.2' }),
                    route('EQUAL', [], { requirementCode: 'A.3.2' }),
                ],
            }),
        );
        expect(entry.status).toBe('NOT_APPLICABLE');
        expect(entry.inheritedFrom.map((i) => i.requirementCode)).toEqual(['A.4.2', 'A.9.4']);
    });

    it('excludes N/A risks from the denominator, so the percentage is about the agent', () => {
        const summary = summariseAgentRiskCoverage([
            classifyAgentRiskCoverage(risk({ code: 'ASI01', directControls: [control('A')] })),
            classifyAgentRiskCoverage(risk({ code: 'ASI02', applicability: notApplicable() })),
        ]);
        expect(summary.total).toBe(2);
        expect(summary.applicableTotal).toBe(1);
        expect(summary.notApplicable).toEqual(['ASI02']);
        // 1/1, not 1/2. Measured against the catalogue this would read 50%,
        // which is the tool marking itself down for a risk it has just said
        // does not apply.
        expect(summary.coveragePercent).toBe(100);
    });

    it('reports 0% rather than NaN when every risk is N/A', () => {
        const summary = summariseAgentRiskCoverage(
            ['ASI02', 'ASI08'].map((code) =>
                classifyAgentRiskCoverage(risk({ code, applicability: notApplicable() })),
            ),
        );
        expect(summary.applicableTotal).toBe(0);
        expect(summary.coveragePercent).toBe(0);
    });
});
