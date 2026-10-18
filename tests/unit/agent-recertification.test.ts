/**
 * #3674 — the pure half of agent recertification: the narrowing rule, the pack
 * plan and its hash, the closing evidence and its hash, and the catalogue
 * facts the evidence is filed against.
 *
 * The database half — creation, the owner rule, the one-way stamps, the close
 * — is `tests/integration/access-review-agent-campaign.test.ts`.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'fs';
import path from 'path';

import {
    AGENT_CAMPAIGN_EVIDENCE_SCHEMA,
    NARROWING_BASIS,
    PROPOSAL_KIND_BY_PROPOSE_TOOL,
    USE_WINDOW_DAYS,
    agentCampaignEvidenceBytes,
    agentCampaignEvidenceHash,
    buildAgentCampaignEvidence,
    narrowingsFor,
    observationWindow,
    planAgentReviewPacks,
    sectionsOf,
    sha256Of,
    type AgentCampaignEvidenceRows,
    type SubjectEvidence,
} from '@/lib/agentic/agent-recertification';
import { PROPOSE_TOOLS } from '@/lib/mcp/tools/propose-tools';
import { AGENT_RECERT_EVIDENCE_OBLIGATIONS } from '@/app-layer/usecases/access-review-agent';
import { ISO27001_FAMILY_URN, SOC2_FAMILY_URN } from '@/app-layer/domain/framework-representation';
import { ASI_LIBRARY_URN } from '@/lib/agentic/evidence-artefact';
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const WINDOW_END = new Date('2026-10-18T00:00:00.000Z');
const WINDOW = observationWindow(WINDOW_END);

function grant(over: Partial<SubjectEvidence['grants'][number]> = {}): SubjectEvidence['grants'][number] {
    return {
        grantId: 'g-1',
        toolName: 'list_risks',
        grantedByUserId: 'u-admin',
        grantedAt: '2026-01-01T00:00:00.000Z',
        lastCalledAt: null,
        heldForWholeWindow: true,
        proposals: null,
        ...over,
    };
}

function subject(over: Partial<SubjectEvidence> = {}): SubjectEvidence {
    return {
        decisionId: 'dec-1',
        agentId: 'ag-1',
        grants: [grant()],
        grantsTruncated: false,
        otherProposals: {},
        cardVersions: { since: null, currentVersion: 1, versions: [] },
        timeBoundedGrants: [],
        guardFlags: {},
        breaker: null,
        killEngagements: [],
        harness: { level: 'H2', previousLevel: 'H1', drift: 'UP', lastSeenAt: '2026-10-01T00:00:00.000Z' },
        ...over,
    };
}

function evidence(subjects: SubjectEvidence[]) {
    return {
        accessReviewId: 'ar-1',
        page: 0,
        pageSize: 20,
        total: subjects.length,
        window: { start: WINDOW.start.toISOString(), end: WINDOW.end.toISOString() },
        subjects,
    };
}

describe('the observation window', () => {
    it('is the 90 days that END at the campaign’s creation', () => {
        expect(USE_WINDOW_DAYS).toBe(90);
        expect(WINDOW.end).toBe(WINDOW_END);
        expect((WINDOW.end.getTime() - WINDOW.start.getTime()) / 86_400_000).toBe(90);
    });
});

describe('a narrowing is proposed only where the evidence supports deleting a grant', () => {
    it('a grant held for the whole window and never called is proposed, with its grantor, date and basis', () => {
        expect(narrowingsFor(subject())).toEqual([{
            grantId: 'g-1',
            toolName: 'list_risks',
            grantedByUserId: 'u-admin',
            grantedAt: '2026-01-01T00:00:00.000Z',
            basis: NARROWING_BASIS,
        }]);
    });

    it('a grant called in the window is not', () => {
        expect(narrowingsFor(subject({ grants: [grant({ lastCalledAt: '2026-09-30T10:00:00.000Z' })] }))).toEqual([]);
    });

    it('a grant younger than the window is not, however unused — it has had no chance to be used', () => {
        expect(narrowingsFor(subject({ grants: [grant({ heldForWholeWindow: false })] }))).toEqual([]);
    });

    it('nothing is proposed from a truncated grant list — a partial list is a claim about grants nobody read', () => {
        expect(narrowingsFor(subject({ grantsTruncated: true }))).toEqual([]);
    });

    it('proposals come out in a stable order, whatever order the grants were read in', () => {
        const s = subject({ grants: [grant({ grantId: 'g-b' }), grant({ grantId: 'g-a' })] });
        expect(narrowingsFor(s).map((n) => n.grantId)).toEqual(['g-a', 'g-b']);
    });

    it('the rule can only ever DELETE: every candidate names an existing grant and nothing else', () => {
        const s = subject({ grants: [grant({ grantId: 'g-1' }), grant({ grantId: 'g-2', lastCalledAt: '2026-10-01T00:00:00.000Z' })] });
        const ids = new Set(s.grants.map((g) => g.grantId));
        for (const n of narrowingsFor(s)) {
            expect(ids.has(n.grantId)).toBe(true);
            expect(Object.keys(n).sort()).toEqual(['basis', 'grantId', 'grantedAt', 'grantedByUserId', 'toolName']);
        }
    });
});

describe('the pack plan', () => {
    it('hashes each pack’s sections, and plans its narrowings', () => {
        const s = subject();
        const plan = planAgentReviewPacks(evidence([s]));
        expect(plan.packs).toHaveLength(1);
        expect(plan.packs[0].contentHash).toBe(sha256Of(sectionsOf(s)));
        expect(plan.packs[0].contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(plan.packs[0].narrowings.map((n) => n.grantId)).toEqual(['g-1']);
    });

    it('the sections carry neither identifier, so the hash is about the evidence', () => {
        expect(Object.keys(sectionsOf(subject()))).not.toEqual(expect.arrayContaining(['decisionId']));
        expect(sectionsOf(subject())).not.toHaveProperty('agentId');
    });

    it('a pack whose evidence changes gets another hash', () => {
        const before = planAgentReviewPacks(evidence([subject()])).packs[0].contentHash;
        const after = planAgentReviewPacks(evidence([subject({ guardFlags: { FLAGGED: 1 } })])).packs[0].contentHash;
        expect(after).not.toBe(before);
    });

    it('the hash does not depend on key order', () => {
        expect(sha256Of({ a: 1, b: { c: 2, d: 3 } })).toBe(sha256Of({ b: { d: 3, c: 2 }, a: 1 }));
    });

    it('malformed evidence is refused, never planned as an empty campaign', () => {
        expect(() => planAgentReviewPacks({ accessReviewId: 'ar-1' })).toThrow();
        expect(() => planAgentReviewPacks(null)).toThrow();
    });
});

describe('proposals are attributed to the grant that made them possible', () => {
    it('PROPOSAL_KIND_BY_PROPOSE_TOOL is exactly the propose tools’ own kinds', () => {
        const fromTools = Object.fromEntries(PROPOSE_TOOLS.map((t) => [t.name, t.kind]));
        expect(PROPOSAL_KIND_BY_PROPOSE_TOOL).toEqual(fromTools);
    });
});

// ─── The closing evidence ──────────────────────────────────────────────

function rows(over: Partial<AgentCampaignEvidenceRows> = {}): AgentCampaignEvidenceRows {
    const at = new Date('2026-10-20T12:00:00.000Z');
    return {
        campaign: {
            id: 'ar-1', tenantId: 't-1', name: 'Q4 agents', periodStartAt: null, periodEndAt: null,
            reviewerUserId: 'u-rev', createdByUserId: 'u-admin', createdAt: WINDOW_END,
            closedAt: at, closedByUserId: 'u-admin', snapshotTruncated: false,
            preparerAgentId: 'ag-1', crossPreparerAgentId: 'ag-2',
        },
        subjects: [
            { decisionId: 'dec-2', subjectRef: 'agent:ag-2', subjectAgentId: 'ag-2', subjectOwnerUserId: 'u-o2', snapshotJson: { kind: 'AGENT', agentId: 'ag-2' }, decision: 'CONFIRM', decidedAt: at, decidedByUserId: 'u-rev', notes: null },
            { decisionId: 'dec-1', subjectRef: 'agent:ag-1', subjectAgentId: 'ag-1', subjectOwnerUserId: 'u-o1', snapshotJson: { kind: 'AGENT', agentId: 'ag-1' }, decision: 'REVOKE', decidedAt: at, decidedByUserId: 'u-rev', notes: 'unused' },
        ],
        packs: [
            // ag-1's own pack by the cross-preparer ag-2; ag-2's by the preparer ag-1.
            { decisionId: 'dec-1', contentHash: 'sha256:' + 'a'.repeat(64), preparedByRunId: 'run-2', preparedByAgentId: 'ag-2' },
            { decisionId: 'dec-2', contentHash: 'sha256:' + 'b'.repeat(64), preparedByRunId: 'run-1', preparedByAgentId: 'ag-1' },
        ],
        narrowings: [
            { id: 'n-2', decisionId: 'dec-1', grantId: 'g-2', toolName: 'list_tasks', grantedByUserId: 'u-admin', grantedAt: WINDOW.start, basis: NARROWING_BASIS, outcome: 'REJECTED', decidedAt: at, decidedByUserId: 'u-rev', executedAt: null, executionResult: null },
            { id: 'n-1', decisionId: 'dec-1', grantId: 'g-1', toolName: 'list_risks', grantedByUserId: 'u-admin', grantedAt: WINDOW.start, basis: NARROWING_BASIS, outcome: 'ACCEPTED', decidedAt: at, decidedByUserId: 'u-rev', executedAt: at, executionResult: 'GRANT_DELETED' },
        ],
        samples: [{ decisionId: 'dec-2', samplingEpoch: 'ar-1@2026-10-20' }],
        obligations: AGENT_RECERT_EVIDENCE_OBLIGATIONS.map((o) => ({ familyUrn: o.familyUrn, requirementCode: o.requirementCode })),
        ...over,
    };
}

describe('the closing evidence recomputes from the stored rows', () => {
    it('the same rows, in any order, give the same bytes and the same hash', () => {
        const a = rows();
        const b = rows({
            subjects: [...a.subjects].reverse(),
            packs: [...a.packs].reverse(),
            narrowings: [...a.narrowings].reverse(),
            obligations: [...a.obligations].reverse(),
        });
        const da = buildAgentCampaignEvidence(a);
        const db = buildAgentCampaignEvidence(b);
        expect(agentCampaignEvidenceBytes(db)).toBe(agentCampaignEvidenceBytes(da));
        expect(agentCampaignEvidenceHash(db)).toBe(agentCampaignEvidenceHash(da));
    });

    it('the hash is the hex SHA-256 of exactly the bytes stored, so it equals the file’s own sha256', () => {
        const doc = buildAgentCampaignEvidence(rows());
        const bytes = agentCampaignEvidenceBytes(doc);
        expect(agentCampaignEvidenceHash(doc)).toBe(createHash('sha256').update(bytes, 'utf8').digest('hex'));
    });

    it('every date is an ISO string — a Date would serialise as {} and hash nothing', () => {
        const doc = buildAgentCampaignEvidence(rows());
        expect(doc.campaign.closedAt).toBe('2026-10-20T12:00:00.000Z');
        expect(doc.subjects[0].decidedAt).toBe('2026-10-20T12:00:00.000Z');
        expect(doc.subjects[0].narrowings[0].grantedAt).toBe(WINDOW.start.toISOString());
        expect(agentCampaignEvidenceBytes(doc)).not.toContain('{}');
    });

    it('changing one stored decision changes the hash', () => {
        const base = rows();
        const changed = rows({ subjects: base.subjects.map((s) => (s.decisionId === 'dec-2' ? { ...s, decision: 'REVOKE' } : s)) });
        expect(agentCampaignEvidenceHash(buildAgentCampaignEvidence(changed)))
            .not.toBe(agentCampaignEvidenceHash(buildAgentCampaignEvidence(base)));
    });

    it('carries the population, each pack’s hash, each narrowing’s outcome, the sample and the obligations', () => {
        const doc = buildAgentCampaignEvidence(rows());
        expect(doc.schema).toBe(AGENT_CAMPAIGN_EVIDENCE_SCHEMA);
        expect(doc.subjectCount).toBe(2);
        expect(doc.subjects.map((s) => s.subjectRef)).toEqual(['agent:ag-1', 'agent:ag-2']);
        expect(doc.subjects[0].pack).toEqual({ contentHash: 'sha256:' + 'a'.repeat(64), preparedByRunId: 'run-2', preparedByAgentId: 'ag-2' });
        expect(doc.campaign).toMatchObject({ preparerAgentId: 'ag-1', crossPreparerAgentId: 'ag-2' });
        expect(doc.subjects[0].narrowings.map((n) => [n.id, n.outcome, n.executionResult])).toEqual([
            ['n-1', 'ACCEPTED', 'GRANT_DELETED'],
            ['n-2', 'REJECTED', null],
        ]);
        expect(doc.sample).toEqual({ epoch: 'ar-1@2026-10-20', decisionIds: ['dec-2'] });
        expect(doc.obligations.map((o) => o.requirementCode).sort()).toEqual(['A.5.18', 'ASI03', 'CC6.1']);
    });
});

// ─── The obligations, against the catalogues this repository holds ─────

describe('the evidence is filed against obligations the catalogues actually hold', () => {
    const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

    it('names ISO/IEC 27001 A.5.18, SOC 2 CC6.1 and OWASP ASI03, by family', () => {
        expect(AGENT_RECERT_EVIDENCE_OBLIGATIONS.map((o) => [o.familyUrn, o.requirementCode])).toEqual([
            [ISO27001_FAMILY_URN, 'A.5.18'],
            [SOC2_FAMILY_URN, 'CC6.1'],
            [ASI_LIBRARY_URN, 'ASI03'],
        ]);
    });

    it('SOC 2 CC6.3, which the brief names, is in NEITHER representation — asserted, not assumed', () => {
        // The premise of the CC6.1 substitution. If a catalogue change ADDS
        // CC6.3, this fails and the obligation list should be revisited rather
        // than left understating what the evidence covers.
        const library = read('src/data/libraries/soc2-2017.yaml');
        // Comments masked: a seed line commented out is not a seeded code.
        const seed = codeOf(read('prisma/seed-catalog.ts'));
        expect(library).not.toMatch(/ref_id:\s*CC6\.3\b/);
        expect(seed).not.toMatch(/code:\s*'CC6\.3'/);
        expect(library).toMatch(/ref_id:\s*CC6\.1\s*$/m);
        expect(seed).toMatch(/\{ code: 'CC6\.1', title: 'Logical and physical access controls'/);
        const soc2 = AGENT_RECERT_EVIDENCE_OBLIGATIONS.find((o) => o.familyUrn === SOC2_FAMILY_URN);
        expect(soc2?.note).toMatch(/CC6\.3/);
    });

    it('A.5.18 is seeded (as 5.18), and ASI03 is in both ASI representations', () => {
        const annexA = JSON.parse(read('prisma/fixtures/iso27001_2022_annexA.json')) as Array<{ key: string }>;
        expect(annexA.some((r) => r.key === '5.18')).toBe(true);
        const asiSeed = JSON.parse(read('prisma/fixtures/owasp_asi_requirements.json')) as Array<{ key: string }>;
        expect(asiSeed.some((r) => r.key === 'ASI03')).toBe(true);
        expect(read('src/data/libraries/owasp-agentic-top10.yaml')).toMatch(/ref_id:\s*ASI03\s*$/m);
    });
});
