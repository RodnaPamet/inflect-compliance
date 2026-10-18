/**
 * What the two IAM skills may answer (#3668): the output contracts in
 * `src/lib/agentic/iam-skill-outputs.ts`, which the scanner ingest and the
 * registration intake (step 2a) parse an answer through before using it.
 *
 * Two hardening items of step 1d are proved here:
 *
 *   • ATTRIBUTION OUTPUT CAN ONLY BE A SUGGESTION, NEVER A CONFIRMED LINK — at
 *     the parser (a confirmed or linked status, or any member that records an
 *     owner, is refused) and at the type level (`AttributionStatus` cannot hold
 *     `LINKED`; `tsc` checks the `@ts-expect-error` lines below).
 *   • ASSESSMENT OUTPUT NAMES AN EVIDENCE REFERENCE FOR EVERY CRITERION OR SAYS
 *     IT IS NOT EVIDENCED — a met verdict without a reference is refused, and so
 *     is an answer that leaves a criterion out.
 */
import {
    ATTRIBUTION_STATUSES,
    gradeFor,
    parseHarnessAssessment,
    parseOwnershipAttribution,
    toCriterionVerdicts,
    type AttributionStatus,
    type OwnerSignal,
    type OwnershipAttribution,
} from '@/lib/agentic/iam-skill-outputs';
import {
    ALL_HARNESS_CRITERIA,
    HARNESS_CRITERIA,
    scoreHarness,
    type HarnessCriterionId,
} from '@/lib/agentic/harness-ladder';

const AGENT = 'da_01JFAKE';

/** Every H1 criterion evidenced; everything above it not evidenced. */
function fullAssessment(): { discoveredAgentId: string; verdicts: Array<Record<string, unknown>> } {
    const h1 = HARNESS_CRITERIA.H1 as readonly HarnessCriterionId[];
    return {
        discoveredAgentId: AGENT,
        verdicts: ALL_HARNESS_CRITERIA.map((criterion) =>
            h1.includes(criterion)
                ? { criterion, met: true, evidence: `inflect-register:RegisteredAgent/agt_1#${criterion}` }
                : { criterion, met: false, evidence: null, notEvidenced: true },
        ),
    };
}

function withVerdict(criterion: HarnessCriterionId, verdict: Record<string, unknown>) {
    const a = fullAssessment();
    a.verdicts = a.verdicts.map((v) => (v.criterion === criterion ? { criterion, ...verdict } : v));
    return a;
}

/** A credential-shaped string, assembled at runtime so no literal exists for the secret scanners. */
const fakeSecret = () => ['gh', 'p_', 'Q'.repeat(36)].join('');

describe('the assessment names an evidence reference for every criterion, or says it is not evidenced', () => {
    it('accepts an answer in which every criterion either cites evidence or says it is not evidenced', () => {
        const parsed = parseHarnessAssessment(fullAssessment());
        expect(parsed).toMatchObject({ ok: true });
        if (!parsed.ok) return;
        expect(parsed.value.verdicts).toHaveLength(ALL_HARNESS_CRITERIA.length);
        for (const v of parsed.value.verdicts) {
            expect(v.evidence !== null || ('notEvidenced' in v && v.notEvidenced === true)).toBe(true);
        }
    });

    it('hands the ladder verdicts it can score — and the level is the ladder’s, not the answer’s', () => {
        const parsed = parseHarnessAssessment(fullAssessment());
        if (!parsed.ok) throw new Error(parsed.issues.join('; '));
        expect(scoreHarness(toCriterionVerdicts(parsed.value))).toEqual({
            level: 'H1',
            blockingNextRung: HARNESS_CRITERIA.H2,
        });
    });

    it.each([
        ['null', null],
        ['blank', '   '],
        ['empty', ''],
    ])('refuses a MET verdict whose evidence is %s, rather than coercing it', (_label, evidence) => {
        const parsed = parseHarnessAssessment(withVerdict('H1.owner', { met: true, evidence }));
        expect(parsed.ok).toBe(false);
        if (parsed.ok) return;
        expect(parsed.issues.join('\n')).toMatch(/verdicts\.1\.evidence/);
    });

    it('refuses a verdict with no evidence that does not say it is not evidenced', () => {
        const parsed = parseHarnessAssessment(withVerdict('H2.policy_card', { met: false, evidence: null }));
        expect(parsed).toMatchObject({ ok: false });
        if (parsed.ok) return;
        expect(parsed.issues.join('\n')).toMatch(/must say it is not evidenced/);
    });

    it('accepts a NOT-met verdict that cites the observation showing it, and refuses one that also says not evidenced', () => {
        const cited = withVerdict('H3.manifests_pinned', { met: false, evidence: 'mcp:https://mcp.internal.example/crm#update_opportunity' });
        expect(parseHarnessAssessment(cited)).toMatchObject({ ok: true });
        const both = withVerdict('H3.manifests_pinned', { met: false, evidence: 'mcp:x#y', notEvidenced: true });
        expect(parseHarnessAssessment(both)).toMatchObject({ ok: false });
    });

    it('accepts an incomplete source as the reason a criterion is not evidenced, and only as that', () => {
        const gap = withVerdict('H3.manifests_pinned', { met: false, evidence: null, notEvidenced: true, incompleteSource: 'mcp' });
        expect(parseHarnessAssessment(gap)).toMatchObject({ ok: true });
        const withEvidence = withVerdict('H3.manifests_pinned', { met: false, evidence: 'mcp:x#y', incompleteSource: 'mcp' });
        expect(parseHarnessAssessment(withEvidence)).toMatchObject({ ok: false });
        const notASource = withVerdict('H3.manifests_pinned', { met: false, evidence: null, notEvidenced: true, incompleteSource: 'github' });
        expect(parseHarnessAssessment(notASource)).toMatchObject({ ok: false });
    });

    it('refuses an answer that leaves a criterion out: unanswered is not evidenced, and must be said', () => {
        const a = fullAssessment();
        a.verdicts = a.verdicts.filter((v) => v.criterion !== 'H4.kill_switch_drilled');
        const parsed = parseHarnessAssessment(a);
        expect(parsed).toEqual({ ok: false, issues: [expect.stringMatching(/^H4\.kill_switch_drilled: not answered/)] });
    });

    it('refuses a criterion answered twice, even when both answers agree', () => {
        const a = fullAssessment();
        a.verdicts.push({ criterion: 'H1.owner', met: true, evidence: 'entra-sp:servicePrincipals/9f1c#owners' });
        expect(parseHarnessAssessment(a, ALL_HARNESS_CRITERIA)).toMatchObject({ ok: false });
    });

    it.each(['H6.independent_audit', 'H1.Owner', 'owner'])('refuses %s, which is not a criterion the ladder defines', (criterion) => {
        const a = fullAssessment();
        a.verdicts[0] = { criterion, met: false, evidence: null, notEvidenced: true };
        expect(parseHarnessAssessment(a)).toMatchObject({ ok: false });
    });

    it('refuses an answer that states its own level', () => {
        expect(parseHarnessAssessment({ ...fullAssessment(), level: 'H5' })).toMatchObject({ ok: false });
    });

    it('refuses an evidence reference that carries a credential value', () => {
        const parsed = parseHarnessAssessment(withVerdict('H2.credential_bound', { met: true, evidence: fakeSecret() }));
        expect(parsed).toMatchObject({ ok: false });
        if (parsed.ok) return;
        // The refusal names where, never what.
        expect(parsed.issues.join('\n')).not.toContain(fakeSecret());
    });

    it('refuses an answer about no criterion at all — zero verdicts evidence nothing', () => {
        expect(parseHarnessAssessment({ discoveredAgentId: AGENT, verdicts: [] }, [])).toMatchObject({ ok: false });
    });

    it('holds a narrower question to exactly the criteria it asked about', () => {
        const one = { discoveredAgentId: AGENT, verdicts: [{ criterion: 'H1.owner', met: true, evidence: 'entra-sp:servicePrincipals/9f1c#owners' }] };
        expect(parseHarnessAssessment(one, ['H1.owner'])).toMatchObject({ ok: true });
        expect(parseHarnessAssessment(one, ['H1.owner', 'H1.registered'])).toMatchObject({ ok: false });
        const extra = { ...one, verdicts: [...one.verdicts, { criterion: 'H1.registered', met: false, evidence: null, notEvidenced: true }] };
        expect(parseHarnessAssessment(extra, ['H1.owner'])).toMatchObject({ ok: false });
    });
});

// ─── The attribution ────────────────────────────────────────────────────────

const signal = (kind: OwnerSignal['kind'], personRef: string | null, personActive: boolean | null = personRef ? true : null): OwnerSignal => ({
    kind,
    evidence: `entra-sp:servicePrincipals/7a01#${kind.toLowerCase()}`,
    personRef,
    personActive,
});

const suggested = (overrides: Record<string, unknown> = {}) => ({
    discoveredAgentId: AGENT,
    status: 'SUGGESTED',
    proposedOwnerRef: 'usr_17',
    grade: 'STRONG',
    signals: [signal('IDENTITY_OWNER', 'usr_17'), signal('CREDENTIAL_ACTOR', 'usr_17')],
    ...overrides,
});

describe('attribution output can only be a suggestion, never a confirmed link', () => {
    it('accepts a suggestion backed by an owner on the identity itself, graded STRONG', () => {
        expect(parseOwnershipAttribution(suggested())).toMatchObject({ ok: true, value: { status: 'SUGGESTED', grade: 'STRONG' } });
    });

    it.each(['LINKED', 'CONFIRMED', 'OWNED', 'linked', 'NON_PERSON'])('refuses the status %s', (status) => {
        expect(parseOwnershipAttribution(suggested({ status }))).toMatchObject({ ok: false });
    });

    it.each([
        ['ownerUserId', 'usr_17'],
        ['confirmed', true],
        ['owned', true],
        ['confirmedBy', 'usr_1'],
        ['link', { accountId: 'x' }],
    ])('refuses an answer that records an owner through a %s member', (key, value) => {
        expect(parseOwnershipAttribution(suggested({ [key]: value }))).toMatchObject({ ok: false });
    });

    it('closes the status at the type level: no reconcile outcome that acts without a reviewer', () => {
        // @ts-expect-error — LINKED is excluded from what a model's attribution can say.
        const linked: AttributionStatus = 'LINKED';
        // @ts-expect-error — CONFIRMED was never an outcome at all.
        const confirmed: AttributionStatus = 'CONFIRMED';
        const asLinked = {
            discoveredAgentId: AGENT,
            proposedOwnerRef: 'usr_17',
            grade: 'STRONG' as const,
            signals: [] as OwnerSignal[],
            status: 'LINKED' as const,
        };
        // @ts-expect-error — and no arm of the answer's type carries it.
        const attribution: OwnershipAttribution = asLinked;
        expect([linked, confirmed, attribution.status]).toEqual(['LINKED', 'CONFIRMED', 'LINKED']);
        expect([...ATTRIBUTION_STATUSES].sort()).toEqual(['AMBIGUOUS', 'SUGGESTED', 'UNMATCHED']);
    });

    describe('the grade and the outcome are checked against the signals, not taken from the answer', () => {
        it('a naming pattern never decides on its own', () => {
            const byName = suggested({ proposedOwnerRef: 'jsmith', grade: 'WEAK', signals: [signal('NAMING_PATTERN', 'jsmith', null)] });
            expect(parseOwnershipAttribution(byName)).toMatchObject({ ok: false });
            const none = { discoveredAgentId: AGENT, status: 'UNMATCHED', reason: 'NO_OWNER_SIGNAL', signals: [signal('NAMING_PATTERN', 'jsmith', null)] };
            expect(parseOwnershipAttribution(none)).toMatchObject({ ok: true });
        });

        it('a group is not an owner: a team tag names nobody who could be proposed', () => {
            expect(parseOwnershipAttribution(suggested({ signals: [signal('TEAM_TAG', 'usr_17')] }))).toMatchObject({ ok: false });
            const tagOnly = suggested({ grade: 'WEAK', signals: [signal('TEAM_TAG', null)] });
            expect(parseOwnershipAttribution(tagOnly)).toMatchObject({ ok: false });
        });

        it('a tie is AMBIGUOUS, never broken', () => {
            const tie = [signal('IDENTITY_OWNER', 'usr_21'), signal('IDENTITY_OWNER', 'usr_22')];
            expect(parseOwnershipAttribution(suggested({ proposedOwnerRef: 'usr_21', grade: 'WEAK', signals: tie }))).toMatchObject({ ok: false });
            expect(parseOwnershipAttribution({ discoveredAgentId: AGENT, status: 'AMBIGUOUS', signals: tie })).toMatchObject({ ok: true });
            expect(parseOwnershipAttribution({ discoveredAgentId: AGENT, status: 'AMBIGUOUS', signals: tie.slice(0, 1) })).toMatchObject({ ok: false });
        });

        it('a person who has left is never proposed: that is an orphan', () => {
            const departed = [signal('IDENTITY_OWNER', 'usr_30', false)];
            expect(parseOwnershipAttribution(suggested({ proposedOwnerRef: 'usr_30', grade: 'WEAK', signals: departed }))).toMatchObject({ ok: false });
            // Nor is a weaker-signalled colleague while the strongest signal names the departed one.
            const behind = [...departed, signal('DEPLOYMENT_OWNER', 'usr_31')];
            expect(parseOwnershipAttribution(suggested({ proposedOwnerRef: 'usr_31', grade: 'WEAK', signals: behind }))).toMatchObject({ ok: false });
            const orphan = { discoveredAgentId: AGENT, status: 'UNMATCHED', reason: 'OWNER_DEPARTED', signals: departed };
            expect(parseOwnershipAttribution(orphan)).toMatchObject({ ok: true });
            expect(parseOwnershipAttribution({ ...orphan, signals: [signal('IDENTITY_OWNER', 'usr_30')] })).toMatchObject({ ok: false });
        });

        it('a proposal may not skip the strongest signal for a weaker one', () => {
            const signals = [signal('IDENTITY_OWNER', 'usr_17'), signal('DEPLOYMENT_OWNER', 'usr_40')];
            expect(parseOwnershipAttribution(suggested({ proposedOwnerRef: 'usr_40', grade: 'WEAK', signals }))).toMatchObject({ ok: false });
        });

        it('STRONG needs an identity-owner or credential signal naming one ACTIVE person; anything else is WEAK', () => {
            const deployOnly = [signal('DEPLOYMENT_OWNER', 'usr_17')];
            expect(parseOwnershipAttribution(suggested({ signals: deployOnly }))).toMatchObject({ ok: false });
            expect(parseOwnershipAttribution(suggested({ grade: 'WEAK', signals: deployOnly }))).toMatchObject({ ok: true });
            // Activity the input never stated is not "active".
            const unknown = [signal('IDENTITY_OWNER', 'usr_17', null)];
            expect(gradeFor('usr_17', unknown)).toBe('WEAK');
            expect(parseOwnershipAttribution(suggested({ signals: unknown }))).toMatchObject({ ok: false });
            // And an answer that under-claims is refused too: the grade is the signals'.
            expect(parseOwnershipAttribution(suggested({ grade: 'WEAK' }))).toMatchObject({ ok: false });
        });

        it('"no owner signal" is refused when a signal does name a person', () => {
            const claim = { discoveredAgentId: AGENT, status: 'UNMATCHED', reason: 'NO_OWNER_SIGNAL', signals: [signal('IDENTITY_OWNER', 'usr_17')] };
            expect(parseOwnershipAttribution(claim)).toMatchObject({ ok: false });
        });

        it('a suggestion with no signal behind it is refused', () => {
            expect(parseOwnershipAttribution(suggested({ signals: [] }))).toMatchObject({ ok: false });
        });
    });

    it('refuses a signal whose evidence carries a credential value', () => {
        const leaked = { ...signal('CREDENTIAL_ACTOR', 'usr_17'), evidence: fakeSecret() };
        expect(parseOwnershipAttribution(suggested({ signals: [signal('IDENTITY_OWNER', 'usr_17'), leaked] }))).toMatchObject({ ok: false });
    });
});
