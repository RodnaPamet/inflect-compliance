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
                                    provenance: 'FIRST_PARTY',
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

/**
 * THE AUTONOMY RUNG, IN THE ARTEFACT (#2568).
 *
 * The register row filed `autonomy 4` — a bare integer with no denominator and
 * no meaning, in the one surface whose reader cannot click through to the
 * ladder. The screen has said what a rung means since #2457; the filed document
 * is the copy that has to carry it, because "every piece of context the screen
 * supplies by being the screen has to be written INTO this text or it is gone".
 *
 * Each case below names the mutation it exists to catch. All three were run
 * RED before this block was kept:
 *   • reverting the row to `autonomy ${a.autonomyLevel}` reddens the first;
 *   • one fixed sentence for every rung reddens the second;
 *   • `AUTONOMY_MAX` 6 -> 7 reddens the third (denominator AND ladder span).
 */
describe('the autonomy rung is explained where it is filed', () => {
    function agentAt(agentId: string, autonomyLevel: number, unattended = false) {
        return {
            agentId,
            name: `Agent ${agentId}`,
            status: 'ACTIVE',
            autonomyLevel,
            unattended,
            ownerName: 'Ada',
            ownerUserId: 'u1',
            provenance: 'FIRST_PARTY',
            riskTier: 'LOW',
            assessmentState: 'ASSESSED',
            killState: 'RUNNING',
            policyCardVersion: 3,
        };
    }

    function docWith(agents: ReturnType<typeof agentAt>[]): string {
        return renderGovernancePackDocument(
            input({
                pack: {
                    ...input().pack,
                    inventory: env('agent-inventory', {
                        body: { agents, legacyPlaceholderPresent: false },
                    }),
                },
            }),
        );
    }

    /** The one register row for an agent, so a claim about it cannot be satisfied by another row. */
    function rowFor(doc: string, agentId: string): string {
        const row = doc.split('\n').find((line) => line.includes(`[${agentId}]`));
        expect(row).toBeDefined();
        return row ?? '';
    }

    /** What the row says the rung MEANS — the segment after the figure. */
    function meaningOf(row: string): string {
        const segments = row.split(' — ');
        return segments[segments.length - 1];
    }

    it('files every rung with its denominator and its meaning, never a bare integer', () => {
        const doc = docWith([agentAt('a0', 0), agentAt('a1', 1), agentAt('a2', 2), agentAt('a3', 3)]);

        expect(rowFor(doc, 'a0')).toContain('autonomy 0 of 6 — suggests only, calls nothing');
        expect(rowFor(doc, 'a1')).toContain('autonomy 1 of 6 — reads workspace data');
        expect(rowFor(doc, 'a2')).toContain('autonomy 2 of 6 — drafts changes for approval');
        expect(rowFor(doc, 'a3')).toContain('autonomy 3 of 6 — chains steps between checkpoints');

        // The defect itself: the rung standing alone with nothing after it.
        expect(rowFor(doc, 'a3')).not.toContain('autonomy 3,');
    });

    it('gives three rungs three DIFFERENT meanings, not one sentence repeated', () => {
        // Rung 6 rather than an unattended rung 5 on purpose: the `(UNATTENDED)`
        // suffix would make that row's text differ even when every rung had
        // collapsed to one meaning, and this case is about the meanings alone.
        const doc = docWith([agentAt('a0', 0), agentAt('a3', 3), agentAt('a6', 6)]);
        const bottom = meaningOf(rowFor(doc, 'a0'));
        const declaredTop = meaningOf(rowFor(doc, 'a3'));
        const aboveTop = meaningOf(rowFor(doc, 'a6'));

        expect(new Set([bottom, declaredTop, aboveTop]).size).toBe(3);
        expect(bottom).toContain('suggests only, calls nothing');
        expect(declaredTop).toContain('chains steps between checkpoints');
        expect(aboveTop).toContain('no capability requires this rung');
    });

    it('states the whole ladder once, above the rows it explains', () => {
        const doc = docWith([agentAt('a4', 4)]);

        // The bounds are spelled out rather than derived from the constants:
        // a ladder that grows reddens this, which is the point — somebody has
        // to re-read the legend before a new rung ships in a filed artefact.
        expect(doc).toContain('Autonomy ladder — 0 to 6, and what each rung permits:');
        expect(doc).toContain('  0 — Suggests to a human in session.');
        expect(doc).toContain('  1 — Reads workspace data out of the workspace');
        expect(doc).toContain('  2 — Drafts changes into the approval queue');
        expect(doc).toContain('  3 — Chains steps unattended between checkpoints.');
        expect(doc).toContain('  4-6 — No capability requires this rung');

        // ONCE, and before the register — not repeated per row.
        expect(doc.split('Autonomy ladder —').length - 1).toBe(1);
        expect(doc.indexOf('Autonomy ladder —')).toBeLessThan(doc.indexOf('Register:'));

        // The rung is a claim; the enforced value is a minimum over three terms.
        expect(doc).toContain("lowest of that rung, its credential's ceiling");
    });

    it('marks an unattended agent, says what the marker means, and marks no attended one', () => {
        // BOTH directions in one case: a renderer that emitted the marker
        // unconditionally passes a one-way test while telling every attended
        // agent, in a filed record, that it runs with nobody watching.
        const doc = docWith([agentAt('a4', 4), agentAt('a5', 5, true)]);

        expect(rowFor(doc, 'a5')).toContain('(UNATTENDED)');
        expect(rowFor(doc, 'a4')).not.toContain('UNATTENDED');

        // The threshold the marker encodes, in the document rather than in
        // `agent-risk-scoring.ts` — moving UNATTENDED_AUTONOMY reddens this.
        expect(doc).toContain(
            '(UNATTENDED) marks rung 5 and above — operating with no human in the loop.',
        );
    });
});

/**
 * Provenance on the register row.
 *
 * The pack cites `inventory.third_party_agents` as a figure and writes its
 * definition into the appendix, so the filed document says HOW MANY agents in
 * this workspace are somebody else's code. Section 1 is the section that
 * enumerates them one per row, and it is the only place that can say WHICH.
 *
 * Every needle here is asserted against a SLICE of section 1 rather than the
 * whole document, and that is the assertion rather than a tidiness: both
 * `THIRD_PARTY` and `FIRST_PARTY` appear verbatim in the appendix definition
 * of that figure (`Population: … provenance = THIRD_PARTY`, `Excludes:
 * FIRST_PARTY agents`), so `expect(doc).toContain('THIRD_PARTY')` passes on a
 * document whose register rows say nothing at all.
 */
describe('the register names whose code each agent is', () => {
    function agentWith(agentId: string, provenance: string) {
        return {
            agentId,
            name: `Agent ${agentId}`,
            status: 'ACTIVE',
            autonomyLevel: 2,
            unattended: false,
            ownerName: 'Ada',
            ownerUserId: 'u1',
            provenance,
            riskTier: 'LOW',
            assessmentState: 'ASSESSED',
            killState: 'RUNNING',
            policyCardVersion: 3,
        };
    }

    /** Section 1 alone — from its heading up to the next section's. */
    function section1(agents: ReturnType<typeof agentWith>[]): string {
        const doc = renderGovernancePackDocument(
            input({
                pack: {
                    ...input().pack,
                    inventory: env('agent-inventory', {
                        body: { agents, legacyPlaceholderPresent: false },
                    }),
                },
            }),
        );
        const start = doc.indexOf('1 — AGENT INVENTORY');
        const end = doc.indexOf('2 — ASI RISK COVERAGE');
        // A backwards or empty slice would satisfy every `not.toContain` and
        // fail every positive one for the wrong reason. State the bounds.
        expect(start).toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(start);
        return doc.slice(start, end);
    }

    /** The SECOND line of one agent's row — where the `·`-separated fields sit. */
    function detailLineFor(s1: string, agentId: string): string {
        const lines = s1.split('\n');
        const i = lines.findIndex((line) => line.includes(`[${agentId}]`));
        expect(i).toBeGreaterThan(-1);
        return lines[i + 1] ?? '';
    }

    it('states provenance on the register row, third-party AND first-party', () => {
        // BOTH directions, because an unlabelled FIRST_PARTY row leaves "not in
        // section 5" as the reader's inference rather than the document's
        // statement — and above DOCUMENT_ROW_CAP the two sections are different
        // subsets, so that inference silently stops being available at all.
        const s1 = section1([agentWith('a1', 'FIRST_PARTY'), agentWith('a2', 'THIRD_PARTY')]);

        expect(s1).toContain('Provenance: THIRD_PARTY');
        expect(s1).toContain('Provenance: FIRST_PARTY');
    });

    it('binds each provenance to the agent it describes, not merely to the section', () => {
        // Section-level containment is satisfied by a renderer that prints both
        // values on every row. The claim is per-agent, so the read is per-row.
        const s1 = section1([agentWith('a1', 'FIRST_PARTY'), agentWith('a2', 'THIRD_PARTY')]);

        expect(detailLineFor(s1, 'a1')).toContain('Provenance: FIRST_PARTY');
        expect(detailLineFor(s1, 'a1')).not.toContain('THIRD_PARTY');
        expect(detailLineFor(s1, 'a2')).toContain('Provenance: THIRD_PARTY');
    });

    // A third case asserting `not.toContain('Provenance: Third party')` was
    // written here and REMOVED rather than kept. The enum-code decision is real
    // — every neighbouring field on the row prints its code, and this document
    // is deliberately not localised — but that needle could not be made to fail
    // on its own: rendering prose reddens the two cases above first, because
    // they name the code, so the negative never ran. An assertion that cannot
    // fail is not protecting the decision; the two cases above already are.
});

describe('the title', () => {
    it('carries the generation instant, because two exports are two documents', () => {
        expect(packExportTitle(GENERATED)).toBe('Agent governance pack — 2026-05-04 09:30 UTC');
    });
});
