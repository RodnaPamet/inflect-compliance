/**
 * The filed document — what it says, and what it must never say.
 *
 * Pure, so every case here runs without a database. That is the point: the
 * document's TEXT is the deliverable in #2467, and a test that needed a seeded
 * tenant to check a sentence would be run rarely and trusted anyway.
 *
 * The two assertions that matter most are the ones about the enforcement
 * caveat, and they run in BOTH directions. A renderer that emitted the warning
 * unconditionally passes every one-way test while telling an enforcing tenant
 * their own pack is a sample — a false alarm filed in a compliance record, which
 * is a defect of the same size as the missing warning.
 */
import {
    renderGovernancePackDocument,
    packExportTitle,
    renderMeasure,
    type PackDocumentInput,
} from '@/lib/agentic/pack-document';
import {
    MEASURE_BASES,
    measured,
    noPopulation,
    notAssessed,
} from '@/lib/agentic/report-measures';
import { METRIC_DEFINITIONS } from '@/lib/agentic/report-definitions';

const GENERATED = new Date('2026-05-04T09:30:00.000Z');

function env(reportId: string, over: Partial<Record<string, unknown>> = {}) {
    return {
        reportId,
        generatedAt: GENERATED,
        window: null,
        truncated: false,
        metrics: {},
        definitions: [],
        body: {},
        ...over,
    } as never;
}

function input(over: Partial<PackDocumentInput> = {}): PackDocumentInput {
    return {
        pack: {
            generatedAt: GENERATED,
            tenantId: 'tenant-1',
            inventory: env('agent-inventory', {
                body: { agents: [], legacyPlaceholderPresent: false },
            }),
            asiCoverage: env('asi-coverage', {
                body: { frameworkInstalled: false, framework: null, agents: [], risks: [] },
            }),
            approvals: env('approval-statistics', {
                window: { days: 90, since: new Date('2026-02-03T09:30:00.000Z') },
                body: {
                    unobservable: [],
                    signals: [],
                    thresholds: {},
                    sampleAudit: {
                        sampled: 0,
                        answered: 0,
                        pending: 0,
                        concurred: 0,
                        dissented: 0,
                        indeterminate: 0,
                    },
                },
            }),
            incidents: env('incident-history', {
                body: { kills: [], drillCanaryKills: [], drills: [], breakers: [] },
            }),
            thirdParty: env('third-party-assessments', {
                body: { agents: [], toolManifests: [] },
            }),
        },
        enforcing: true,
        unboundCredentials: 0,
        exportedByUserId: 'user-1',
        workspaceName: 'Acme',
        ...over,
    } as PackDocumentInput;
}

describe('the enforcement caveat, in both directions', () => {
    it('warns loudly, and FIRST, when registration is not enforced', () => {
        const doc = renderGovernancePackDocument(
            input({ enforcing: false, unboundCredentials: 3 }),
        );
        expect(doc).toContain('SAMPLE, NOT A POPULATION');
        expect(doc).toContain('requireRegisteredAgent');
        expect(doc).toContain('Credentials that can call agent tools while bound to NO agent: 3');

        // FIRST is load-bearing, not a nicety: a reader who stops after the
        // opening screen must have stopped after the qualification.
        expect(doc.indexOf('SAMPLE, NOT A POPULATION')).toBeLessThan(doc.indexOf('PROVENANCE'));
        expect(doc.indexOf('SAMPLE, NOT A POPULATION')).toBeLessThan(
            doc.indexOf('1 — AGENT INVENTORY'),
        );
    });

    it('does NOT warn when registration IS enforced', () => {
        const doc = renderGovernancePackDocument(input({ enforcing: true }));
        expect(doc).not.toContain('SAMPLE, NOT A POPULATION');
        expect(doc).not.toContain('is off');
        expect(doc).toContain('REGISTRATION IS ENFORCED');
    });
});

describe('no figure is coerced', () => {
    it('renders a MEASURED zero as a real zero', () => {
        expect(renderMeasure('m', measured(0))).toBe('m: 0');
    });

    it('renders an absent population as its code AND its sentence, never as 0', () => {
        const line = renderMeasure('m', noPopulation('NO_AGENTS_REGISTERED'));
        expect(line).toContain('NO_POPULATION');
        expect(line).toContain('NO_AGENTS_REGISTERED');
        expect(line).toContain('nothing to count');
        expect(line).not.toMatch(/:\s*0\b/);
    });

    it('says a missing framework has not been assessed rather than scoring it zero', () => {
        const line = renderMeasure('m', notAssessed('ASI_FRAMEWORK_NOT_INSTALLED'));
        expect(line).toContain('NOT_ASSESSED');
        expect(line).toContain('NOT a coverage of zero');
    });

    it('names an id that produced no measure at all rather than omitting it', () => {
        expect(renderMeasure('m', undefined)).toContain('NOT REPORTED');
    });
});

describe('every basis code has a sentence', () => {
    /**
     * DRIVEN FROM `MEASURE_BASES`, not from a list retyped here.
     *
     * The original map was `Record<string, string>` with seven INVENTED keys —
     * names recalled instead of read — so seven of the twelve real codes
     * rendered "no explanation is registered for this code" in the filed
     * document. Every hand-written test passed, because they asserted the same
     * invented constants.
     *
     * The type now makes that impossible at compile time. This is the runtime
     * half: it reads the real vocabulary, so a code added later without a
     * sentence fails here too, and it can never agree with a mistake because it
     * does not restate the list.
     */
    it.each(MEASURE_BASES.map((b) => [b] as const))(
        '%s renders a real explanation, not the fallback',
        (basis) => {
            const line = renderMeasure('m', notAssessed(basis));
            expect(line).toContain(basis);
            expect(line).not.toContain('No explanation is registered');
            // And the sentence is not merely present but SAYS something: the
            // code plus a bare period would satisfy a `toContain` check.
            const sentence = line.split('—')[1] ?? '';
            expect(sentence.trim().length).toBeGreaterThan(20);
        },
    );
});

describe('the document carries its own meaning', () => {
    it('names WHICH "ASI coverage" figure this is', () => {
        const doc = renderGovernancePackDocument(input());
        // Two unrelated numbers in this product share the name. An assessor
        // handed the platform's CI measure instead of their own workspace's is
        // the failure this paragraph exists to prevent.
        expect(doc).toContain("THIS WORKSPACE'S control");
        expect(doc).toContain("platform's internal CI measure");
    });

    it('writes every cited definition into the appendix, de-duplicated', () => {
        const defs = [
            METRIC_DEFINITIONS['inventory.registered_agents'],
            METRIC_DEFINITIONS['inventory.active_agents'],
        ];
        const doc = renderGovernancePackDocument(
            input({
                pack: {
                    ...input().pack,
                    inventory: env('agent-inventory', {
                        metrics: {
                            'inventory.registered_agents': measured(2),
                            'inventory.active_agents': measured(1),
                        },
                        definitions: defs,
                        body: { agents: [], legacyPlaceholderPresent: false },
                    }),
                    // The SAME definition cited by a second report must appear
                    // once, not twice — an appendix that repeats itself reads as
                    // two different definitions of one figure.
                    thirdParty: env('third-party-assessments', {
                        definitions: [METRIC_DEFINITIONS['inventory.registered_agents']],
                        body: { agents: [], toolManifests: [] },
                    }),
                },
            }),
        );
        expect(doc).toContain('APPENDIX');
        expect(doc).toContain(METRIC_DEFINITIONS['inventory.registered_agents'].population);
        const occurrences = doc.split('  inventory.registered_agents — ').length - 1;
        expect(occurrences).toBe(1);
    });

    it('states the truncation rather than presenting a partial list as whole', () => {
        const doc = renderGovernancePackDocument(
            input({
                pack: {
                    ...input().pack,
                    inventory: env('agent-inventory', {
                        truncated: true,
                        body: { agents: [], legacyPlaceholderPresent: false },
                    }),
                },
            }),
        );
        expect(doc).toContain('TRUNCATED');
    });

    it('names the legacy placeholder rather than dropping it silently', () => {
        const doc = renderGovernancePackDocument(
            input({
                pack: {
                    ...input().pack,
                    inventory: env('agent-inventory', {
                        body: { agents: [], legacyPlaceholderPresent: true },
                    }),
                },
            }),
        );
        expect(doc).toContain('legacy placeholder');
    });
});

describe('tenant text cannot carry markup into a filed record', () => {
    it('strips tags from an agent name', () => {
        const doc = renderGovernancePackDocument(
            input({
                pack: {
                    ...input().pack,
                    inventory: env('agent-inventory', {
                        body: {
                            agents: [
                                {
                                    agentId: 'a1',
                                    name: '<img src=x onerror=alert(1)>Bot',
                                    status: 'ACTIVE',
                                    autonomyLevel: 1,
                                    unattended: false,
                                    ownerName: 'Ada',
                                    ownerUserId: 'u1',
                                    riskTier: null,
                                    assessmentState: 'NEVER_ASSESSED',
                                    killState: 'RUNNING',
                                    policyCardVersion: null,
                                },
                            ],
                            legacyPlaceholderPresent: false,
                        },
                    }),
                },
            }),
        );
        expect(doc).not.toContain('onerror');
        expect(doc).not.toContain('<img');
        expect(doc).toContain('Bot');
        // The unscored agent still reads as unscored, not as a low tier.
        expect(doc).toContain('UNSCORED');
        expect(doc).toContain('NEVER_ASSESSED');
        expect(doc).toContain('Policy card: NONE');
    });

    it('strips an entity-encoded payload too', () => {
        const doc = renderGovernancePackDocument(
            input({
                pack: {
                    ...input().pack,
                    thirdParty: env('third-party-assessments', {
                        body: {
                            agents: [
                                {
                                    agentId: 'a2',
                                    name: 'Vendor bot',
                                    vendorName: '&lt;script&gt;x&lt;/script&gt;',
                                    vendorUnresolved: false,
                                    latestCompletedAssessment: null,
                                },
                            ],
                            toolManifests: [],
                        },
                    }),
                },
            }),
        );
        expect(doc).not.toContain('<script>');
        expect(doc).toContain('NONE COMPLETED');
    });
});

describe('the worst rows are stated, not softened', () => {
    it('calls an unresolvable supplier what it is', () => {
        const doc = renderGovernancePackDocument(
            input({
                pack: {
                    ...input().pack,
                    thirdParty: env('third-party-assessments', {
                        body: {
                            agents: [
                                {
                                    agentId: 'a3',
                                    name: 'Orphan',
                                    vendorName: null,
                                    vendorUnresolved: true,
                                    latestCompletedAssessment: null,
                                },
                            ],
                            toolManifests: [],
                        },
                    }),
                },
            }),
        );
        expect(doc).toContain('SUPPLIER CANNOT BE RESOLVED');
        expect(doc).toContain('third-party code with no supplier record');
    });

    it('says a kill is still in force', () => {
        const doc = renderGovernancePackDocument(
            input({
                pack: {
                    ...input().pack,
                    incidents: env('incident-history', {
                        body: {
                            kills: [
                                {
                                    scope: 'TENANT',
                                    agentName: null,
                                    reason: 'runaway tool loop',
                                    engagedByUserId: 'u9',
                                    engagedAt: new Date('2026-05-01T00:00:00.000Z'),
                                    durationMinutes: 4410,
                                    stillInForce: true,
                                },
                            ],
                            drillCanaryKills: [{}, {}],
                            drills: [],
                            breakers: [],
                        },
                    }),
                },
            }),
        );
        expect(doc).toContain('STILL IN FORCE');
        expect(doc).toContain('runaway tool loop');
        expect(doc).toContain('Engaged by: u9');
        expect(doc).toContain('whole workspace');
        // Drill canaries counted apart: an exercise is not an incident.
        expect(doc).toContain('an exercise is not an ');
        expect(doc).toContain('incident: 2');
    });

    it('names what approval quality cannot answer', () => {
        const doc = renderGovernancePackDocument(
            input({
                pack: {
                    ...input().pack,
                    approvals: env('approval-statistics', {
                        body: {
                            unobservable: ['whether a reviewer read the diff'],
                            signals: [],
                            thresholds: { minSample: 5 },
                            sampleAudit: {
                                sampled: 0,
                                answered: 0,
                                pending: 0,
                                concurred: 0,
                                dissented: 0,
                                indeterminate: 0,
                            },
                        },
                    }),
                },
            }),
        );
        expect(doc).toContain('WHAT THIS REPORT CANNOT ANSWER');
        expect(doc).toContain('whether a reviewer read the diff');
        expect(doc).toContain('minSample = 5');
    });
});

describe('the title', () => {
    it('carries the generation instant, because two exports are two documents', () => {
        expect(packExportTitle(GENERATED)).toBe('Agent governance pack — 2026-05-04 09:30 UTC');
    });
});
