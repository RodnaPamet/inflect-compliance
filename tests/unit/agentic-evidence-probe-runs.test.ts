/**
 * PROBE_RUNS evidence (active flavour, step 8c): the pure half — which
 * obligations a month of probe runs evidences, when that month is COMPLETE,
 * what its digest covers and what its body says. The emitter against a real
 * database is `tests/integration/probe-runs-evidence-emission.test.ts`.
 */
import {
    AGENTIC_ARTEFACT_KINDS,
    ARTEFACT_KIND_PROBE_RUNS,
    ASI_LIBRARY_URN,
    buildProbeRunArtefact,
    isPerAgentKind,
    monthlyPeriod,
    probeArtefactCompleteness,
    probeArtefactEvidenceStatus,
    probeDigestFacts,
    probeIncompleteReasons,
    sourcePopulationDigest,
    targetsForKind,
    type ProbePeriodFacts,
    type ProbeRunFact,
} from '@/lib/agentic/evidence-artefact';
import { ISO27001_FAMILY_URN, SOC2_FAMILY_URN } from '@/app-layer/domain/framework-representation';

const PERIOD = monthlyPeriod(new Date('2026-11-15T00:00:00.000Z'));

function run(id: string, over: Partial<ProbeRunFact> = {}): ProbeRunFact {
    return {
        id,
        proberAgentId: 'agent_prober',
        engagementId: 'eng-acme-0001',
        scopeDigest: `sha256:${'a'.repeat(64)}`,
        reportDigest: `sha256:${'b'.repeat(64)}`,
        startedAt: '2026-11-10T09:00:00.000Z',
        endedAt: '2026-11-10T09:01:00.000Z',
        stopReason: null,
        concluded: true,
        targetCount: 2,
        targetsReached: 2,
        outcomeCount: 4,
        actedCount: 1,
        disclosedCount: 0,
        resistedCount: 3,
        inconclusiveCount: 0,
        findingCount: 1,
        ...over,
    };
}

function facts(
    runs: ProbeRunFact[],
    over: { runsTruncated?: boolean; silent?: string[]; silentTruncated?: boolean } = {},
): ProbePeriodFacts {
    return {
        runs,
        bounds: { probeBounds: true, runsTruncated: over.runsTruncated ?? false },
        silent: { silentProbers: true, agentIds: over.silent ?? [], truncated: over.silentTruncated ?? false },
    };
}

describe('probe runs become evidence against ASI01, ASI02, ISO A.8.29 and SOC 2 CC4.1 (owner decision)', () => {
    it('targets exactly those four obligations, in their families', () => {
        const targets = targetsForKind(ARTEFACT_KIND_PROBE_RUNS);
        expect(targets.map((t) => `${t.familyUrn}#${t.requirementCode}`).sort()).toEqual(
            [
                `${ASI_LIBRARY_URN}#ASI01`,
                `${ASI_LIBRARY_URN}#ASI02`,
                `${ISO27001_FAMILY_URN}#A.8.29`,
                `${SOC2_FAMILY_URN}#CC4.1`,
            ].sort(),
        );
        expect(AGENTIC_ARTEFACT_KINDS).toContain(ARTEFACT_KIND_PROBE_RUNS);
        expect(isPerAgentKind(ARTEFACT_KIND_PROBE_RUNS)).toBe(false);
    });
});

describe('a probe month is COMPLETE only when every run concluded, none was stopped, and every prober reported', () => {
    it('reads a month with no run as NO_RUN, never as complete', () => {
        expect(probeArtefactCompleteness(facts([]))).toBe('NO_RUN');
        expect(probeArtefactEvidenceStatus('NO_RUN')).toBe('NEEDS_REVIEW');
    });

    it('is COMPLETE for concluded, unstopped runs with no silent prober — whatever the agents did', () => {
        const f = facts([run('r1'), run('r2', { actedCount: 4, resistedCount: 0 })]);
        expect(probeArtefactCompleteness(f)).toBe('COMPLETE');
        expect(probeIncompleteReasons(f)).toEqual([]);
        expect(probeArtefactEvidenceStatus('COMPLETE')).toBe('APPROVED');
    });

    it('is INCOMPLETE when a run was stopped, and says which', () => {
        const f = facts([run('r1'), run('r2', { stopReason: 'STOPPED' })]);
        expect(probeArtefactCompleteness(f)).toBe('INCOMPLETE');
        expect(probeIncompleteReasons(f).join(' ')).toContain('run r2');
    });

    it('is INCOMPLETE when a run concluded nothing', () => {
        const f = facts([run('r1', { concluded: false, resistedCount: 0, actedCount: 0, inconclusiveCount: 4 })]);
        expect(probeArtefactCompleteness(f)).toBe('INCOMPLETE');
        expect(probeIncompleteReasons(f).join(' ')).toContain('concluded nothing');
    });

    it('is INCOMPLETE when a prober that held a live key sent no run', () => {
        const f = facts([run('r1')], { silent: ['agent_idle'] });
        expect(probeArtefactCompleteness(f)).toBe('INCOMPLETE');
        expect(probeIncompleteReasons(f).join(' ')).toContain('agent_idle');
    });

    it('is INCOMPLETE when a bound was reached, so a cut read is never complete', () => {
        expect(probeArtefactCompleteness(facts([run('r1')], { runsTruncated: true }))).toBe('INCOMPLETE');
        expect(probeArtefactCompleteness(facts([run('r1')], { silentTruncated: true }))).toBe('INCOMPLETE');
    });
});

describe('the digest', () => {
    const digest = (f: ProbePeriodFacts) =>
        sourcePopulationDigest(ARTEFACT_KIND_PROBE_RUNS, PERIOD.start, probeDigestFacts(f));

    it('does not depend on row order', () => {
        expect(digest(facts([run('r1'), run('r2')]))).toBe(digest(facts([run('r2'), run('r1')])));
    });

    it('covers silent probers and the bound, so either changing rewrites the body', () => {
        const base = digest(facts([run('r1')]));
        expect(digest(facts([run('r1')], { silent: ['agent_idle'] }))).not.toBe(base);
        expect(digest(facts([run('r1')], { runsTruncated: true }))).not.toBe(base);
    });
});

describe('the body', () => {
    it('says NO PROBE RUN RECEIVED for an empty month, never a clean one', () => {
        const body = buildProbeRunArtefact(PERIOD, facts([]), 'd');
        expect(body.title).toContain('NO PROBE RUN RECEIVED');
        expect(body.content).toContain('UNEVIDENCED');
    });

    it('titles an incomplete month INCOMPLETE and a complete one plainly', () => {
        expect(buildProbeRunArtefact(PERIOD, facts([run('r1', { stopReason: 'CLOSED' })]), 'd').title).toContain('INCOMPLETE');
        expect(buildProbeRunArtefact(PERIOD, facts([run('r1')]), 'd').title).toBe(`Agent probe runs — ${PERIOD.label}`);
    });

    it('carries the redaction contract and the counts', () => {
        const body = buildProbeRunArtefact(PERIOD, facts([run('r1')]), 'digest-x');
        expect(body.content).toContain('REDACTION CONTRACT');
        expect(body.content).toContain('acted 1');
        expect(body.content).toContain('digest-x');
    });
});
