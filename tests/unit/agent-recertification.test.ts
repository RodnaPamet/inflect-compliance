/**
 * #3674 — the pure half of agent recertification: the narrowing rule, the pack
 * plan and the check that it follows from its evidence, the hashes, the
 * closing evidence, and the catalogue facts the evidence is filed against.
 *
 * The database half — creation, the owner rule, the one-way stamps, the close
 * — is `tests/integration/access-review-agent-campaign.test.ts`.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'fs';
import path from 'path';

import {
    AGENT_CAMPAIGN_EVIDENCE_SCHEMA,
    CONNECTION_NAME_IN_PACK,
    NARROWING_BASIS,
    PROPOSAL_KIND_BY_PROPOSE_TOOL,
    RecertificationEvidenceSchema,
    TOOL_NAME_IN_PACK,
    USE_WINDOW_DAYS,
    agentCampaignEvidenceBytes,
    buildAgentCampaignEvidence,
    fullToolNameFor,
    narrowingsFor,
    packConnectionName,
    packToolName,
    observationWindow,
    planAgentReviewPacks,
    sectionsOf,
    type AgentCampaignEvidenceRows,
    type SubjectEvidence,
} from '@/lib/agentic/agent-recertification';
import { agentCampaignEvidenceHash, sha256Of } from '@/lib/agentic/agent-recertification-hash';
import { PROPOSE_TOOLS } from '@/lib/mcp/tools/propose-tools';
import {
    AGENT_RECERT_EVIDENCE_OBLIGATIONS,
    assertStaticRunIsPreparersOwn,
    checkedPlan,
} from '@/app-layer/usecases/access-review-agent';
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
    it('plans each pack’s narrowings and carries no hash — the server hashes the sections it stores', () => {
        const s = subject();
        const plan = planAgentReviewPacks(evidence([s]));
        expect(plan.packs).toHaveLength(1);
        // The plan is built by a workflow step the client bundle reaches, so
        // it holds nothing that needs node:crypto.
        expect(Object.keys(plan.packs[0]).sort()).toEqual(['agentId', 'decisionId', 'narrowings']);
        expect(plan.packs[0].narrowings.map((n) => n.grantId)).toEqual(['g-1']);
        expect(sha256Of(sectionsOf(s))).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    it('the sections carry neither identifier, so the hash is about the evidence', () => {
        expect(Object.keys(sectionsOf(subject()))).not.toEqual(expect.arrayContaining(['decisionId']));
        expect(sectionsOf(subject())).not.toHaveProperty('agentId');
    });

    it('a pack whose evidence changes gets another hash', () => {
        const before = sha256Of(sectionsOf(subject()));
        const after = sha256Of(sectionsOf(subject({ guardFlags: { FLAGGED: 1 } })));
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

describe('the time-bounded truncation flag (#5317) moves no pack filed before it', () => {
    // A subject as the read returned it before #5317: no `timeBoundedTruncated`
    // key. Its pack's sections, and so its stored contentHash, were computed
    // from the parsed evidence — this is that hash, pinned from the code
    // before the field existed.
    const OLD_PACK_HASH = 'sha256:7716a744dea1beb2bf0b2e4ae6fb5fab7fff31c09c3f26628d775d5330921ff1';
    const old = subject({
        timeBoundedGrants: [{
            journalId: 'ewj-1', toolName: 'grant_time_bounded_access', connectionName: 'entra-pim',
            grantedAt: '2026-08-01T00:00:00.000Z', endsAt: '2026-08-02T00:00:00.000Z',
            state: 'OUTLIVED_WINDOW', expiredOnTime: false,
        }],
    });

    it('evidence recorded without the key parses to sections without it, hashing as it did', () => {
        const subjects = (evidence([old]) as { subjects: SubjectEvidence[] }).subjects;
        expect(subjects[0]).not.toHaveProperty('timeBoundedTruncated');
        const reparsed = RecertificationEvidenceSchema.parse(JSON.parse(JSON.stringify(evidence([old]))));
        const sections = sectionsOf(reparsed.subjects[0]);
        expect(sections).not.toHaveProperty('timeBoundedTruncated');
        expect(sha256Of(sections)).toBe(OLD_PACK_HASH);
    });

    it('a run whose READ was recorded before the key still has its plan accepted', () => {
        const recorded = JSON.parse(JSON.stringify(planAgentReviewPacks(evidence([old]))));
        expect(checkedPlan(RecertificationEvidenceSchema.parse(evidence([old])), recorded)).toEqual(recorded);
        // And the flag never changes a plan: it says nothing about which grant to delete.
        expect(planAgentReviewPacks(evidence([{ ...old, timeBoundedTruncated: true }])))
            .toEqual(planAgentReviewPacks(evidence([old])));
    });

    it('a new read keeps the flag through the parse, so the filed pack states it', () => {
        const reparsed = RecertificationEvidenceSchema.parse(evidence([{ ...old, timeBoundedTruncated: true }]));
        expect(sectionsOf(reparsed.subjects[0]).timeBoundedTruncated).toBe(true);
        expect(sha256Of(sectionsOf(reparsed.subjects[0]))).not.toBe(OLD_PACK_HASH);
    });
});

describe('the kill-engagement truncation flag (#5317) moves no pack filed before it', () => {
    // A subject as the read returned it before the kill section was read per
    // agent: no `killsTruncated` key. This is its pack's hash, pinned from the
    // code before the field existed.
    const OLD_KILL_PACK_HASH = 'sha256:6a3429a4fa5829db4c2bd6f808bbc02b12392a044e7c9b4f815bbd32200efd84';
    const old = subject({
        killEngagements: [{
            engagedAt: '2026-08-01T00:00:00.000Z', liftedAt: '2026-08-02T00:00:00.000Z',
            engagedByUserId: 'u-admin', liftedByUserId: 'u-owner',
        }],
    });

    it('evidence recorded without the key parses to sections without it, hashing as it did', () => {
        const reparsed = RecertificationEvidenceSchema.parse(JSON.parse(JSON.stringify(evidence([old]))));
        const sections = sectionsOf(reparsed.subjects[0]);
        expect(sections).not.toHaveProperty('killsTruncated');
        expect(sha256Of(sections)).toBe(OLD_KILL_PACK_HASH);
    });

    it('a run whose READ was recorded before the key still has its plan accepted', () => {
        const recorded = JSON.parse(JSON.stringify(planAgentReviewPacks(evidence([old]))));
        expect(checkedPlan(RecertificationEvidenceSchema.parse(evidence([old])), recorded)).toEqual(recorded);
        expect(planAgentReviewPacks(evidence([{ ...old, killsTruncated: true }])))
            .toEqual(planAgentReviewPacks(evidence([old])));
    });

    it('a new read keeps the flag through the parse, so the filed pack states it', () => {
        const reparsed = RecertificationEvidenceSchema.parse(evidence([{ ...old, killsTruncated: true }]));
        expect(sectionsOf(reparsed.subjects[0]).killsTruncated).toBe(true);
        expect(sha256Of(sectionsOf(reparsed.subjects[0]))).not.toBe(OLD_KILL_PACK_HASH);
    });
});

describe('a pack carries a granted tool’s name cut at TOOL_NAME_IN_PACK (#5317)', () => {
    // A grant may be named up to 200 characters; an external tool's name is
    // `mcp__<connectionId>__<name>`.
    const LONG = `mcp__c${'0'.repeat(24)}__${'microsoft_graph_list_users_by_department_and_manager_'.repeat(2)}`;

    it('a name within the bound is carried whole and unflagged; a longer one is cut to the bound and flagged', () => {
        expect(packToolName('list_risks')).toEqual({ toolName: 'list_risks', truncated: false });
        const exact = 'x'.repeat(TOOL_NAME_IN_PACK);
        expect(packToolName(exact)).toEqual({ toolName: exact, truncated: false });
        expect(LONG.length).toBeGreaterThan(TOOL_NAME_IN_PACK);
        expect(packToolName(LONG)).toEqual({ toolName: LONG.slice(0, TOOL_NAME_IN_PACK), truncated: true });
    });

    it('a narrowing is recorded under the stored name only when the pack’s name is that name cut', () => {
        const cut = packToolName(LONG).toolName;
        expect(fullToolNameFor(cut, LONG)).toBe(LONG);
        expect(fullToolNameFor('list_risks', 'list_risks')).toBe('list_risks');
        // A grant that is gone keeps the pack's name; a stored name that does
        // not reproduce the pack's is not the grant the evidence described.
        expect(fullToolNameFor(cut, undefined)).toBe(cut);
        expect(fullToolNameFor(cut, `${LONG.slice(0, 10)}_other`)).toBe(cut);
        expect(fullToolNameFor('list_risks', 'list_controls')).toBe('list_risks');
    });

    it('the flag never changes a plan: the narrowing names the grant by id, under the name the pack carries', () => {
        const name = packToolName(LONG);
        const s = subject({ grants: [grant({ toolName: name.toolName, toolNameTruncated: true })] });
        expect(narrowingsFor(s)).toEqual(narrowingsFor(subject({ grants: [grant({ toolName: name.toolName })] })));
    });

    // A grant with a long name, as the read returned it before #5317: the
    // name whole, no `toolNameTruncated` key. This is its pack's hash, computed
    // with the module as it stood at 1cab6b8d4 (before the field existed) and
    // checked equal under this one.
    const OLD_LONG_NAME_PACK_HASH = 'sha256:05c85e5b221e834571373211910b0336e01d3a97d63712bac691c1eae9ab5600';
    const old = subject({ grants: [grant({ toolName: LONG })] });

    it('evidence recorded without the key parses to sections without it, hashing as it did', () => {
        const reparsed = RecertificationEvidenceSchema.parse(JSON.parse(JSON.stringify(evidence([old]))));
        const sections = sectionsOf(reparsed.subjects[0]);
        expect(sections.grants[0]).not.toHaveProperty('toolNameTruncated');
        expect(sections.grants[0].toolName).toBe(LONG);
        expect(sha256Of(sections)).toBe(OLD_LONG_NAME_PACK_HASH);
    });

    it('a run whose READ was recorded before the key still has its plan accepted', () => {
        const recorded = JSON.parse(JSON.stringify(planAgentReviewPacks(evidence([old]))));
        expect(checkedPlan(RecertificationEvidenceSchema.parse(evidence([old])), recorded)).toEqual(recorded);
    });

    it('a new read keeps the flag through the parse, so the filed pack states it', () => {
        const cut = subject({ grants: [grant({ toolName: packToolName(LONG).toolName, toolNameTruncated: true })] });
        const reparsed = RecertificationEvidenceSchema.parse(evidence([cut]));
        expect(sectionsOf(reparsed.subjects[0]).grants[0].toolNameTruncated).toBe(true);
        expect(sha256Of(sectionsOf(reparsed.subjects[0]))).not.toBe(OLD_LONG_NAME_PACK_HASH);
    });
});

describe('a pack carries a time-bounded grant’s connection name cut at CONNECTION_NAME_IN_PACK (#5317)', () => {
    const LONG = 'Microsoft Entra ID – Privileged Identity Management (production tenant, EU West)';
    const row = (over: Partial<SubjectEvidence['timeBoundedGrants'][number]> = {}): SubjectEvidence['timeBoundedGrants'][number] => ({
        journalId: 'ewj-1', toolName: 'grant_time_bounded_access', connectionName: 'entra-pim',
        grantedAt: '2026-08-01T00:00:00.000Z', endsAt: '2026-08-02T00:00:00.000Z',
        state: 'OUTLIVED_WINDOW', expiredOnTime: false, ...over,
    });

    it('a short name is carried whole and unflagged; a longer one is cut to the bound and flagged', () => {
        expect(packConnectionName('entra-pim')).toEqual({ connectionName: 'entra-pim', truncated: false });
        expect(LONG.length).toBeGreaterThan(CONNECTION_NAME_IN_PACK);
        expect(packConnectionName(LONG)).toEqual({ connectionName: LONG.slice(0, CONNECTION_NAME_IN_PACK), truncated: true });
    });

    it('a cut never splits a character: the bound counts code points, so no lone surrogate reaches the jsonb column', () => {
        const emoji = '\u{1F512}'.repeat(CONNECTION_NAME_IN_PACK + 1);
        const cut = packConnectionName(emoji);
        expect(cut.truncated).toBe(true);
        expect(Array.from(cut.connectionName)).toHaveLength(CONNECTION_NAME_IN_PACK);
        expect(cut.connectionName).toBe('\u{1F512}'.repeat(CONNECTION_NAME_IN_PACK));
        // Exactly the bound in code points, though twice it in UTF-16 units, is whole.
        expect(packConnectionName('\u{1F512}'.repeat(CONNECTION_NAME_IN_PACK)).truncated).toBe(false);
        expect(packToolName(`a${'\u{1F512}'.repeat(TOOL_NAME_IN_PACK)}`).toolName).not.toMatch(/[\uD800-\uDBFF]$/);
    });

    // A pack whose names are short hashes as it did — this is the
    // time-bounded pack pinned above, re-asserted here because its connection
    // name is the field this bound reads.
    it('a pack whose names are short hashes as it always did', () => {
        const reparsed = RecertificationEvidenceSchema.parse(JSON.parse(JSON.stringify(evidence([subject({ timeBoundedGrants: [row()] })]))));
        expect(sectionsOf(reparsed.subjects[0]).timeBoundedGrants[0]).not.toHaveProperty('connectionNameTruncated');
        expect(sha256Of(sectionsOf(reparsed.subjects[0])))
            .toBe('sha256:7716a744dea1beb2bf0b2e4ae6fb5fab7fff31c09c3f26628d775d5330921ff1');
    });

    // A long connection name as the read returned it before the bound: whole,
    // no flag. Its hash, computed with the module as it stood at 84663f4ec
    // (before the field existed) and checked equal under this one.
    const OLD_LONG_CONNECTION_PACK_HASH = 'sha256:90be52ff833ccdd7c65986fdf863ed500d53662b51f162eb14cca742284a1db7';
    const old = subject({ timeBoundedGrants: [row({ connectionName: LONG })] });

    it('evidence recorded without the key parses to sections without it, hashing as it did', () => {
        const reparsed = RecertificationEvidenceSchema.parse(JSON.parse(JSON.stringify(evidence([old]))));
        const sections = sectionsOf(reparsed.subjects[0]);
        expect(sections.timeBoundedGrants[0]).not.toHaveProperty('connectionNameTruncated');
        expect(sections.timeBoundedGrants[0].connectionName).toBe(LONG);
        expect(sha256Of(sections)).toBe(OLD_LONG_CONNECTION_PACK_HASH);
    });

    it('a new read keeps the flag through the parse, and it never changes a plan', () => {
        const cut = subject({ timeBoundedGrants: [row({ connectionName: packConnectionName(LONG).connectionName, connectionNameTruncated: true })] });
        const reparsed = RecertificationEvidenceSchema.parse(evidence([cut]));
        expect(sectionsOf(reparsed.subjects[0]).timeBoundedGrants[0].connectionNameTruncated).toBe(true);
        expect(sha256Of(sectionsOf(reparsed.subjects[0]))).not.toBe(OLD_LONG_CONNECTION_PACK_HASH);
        expect(planAgentReviewPacks(evidence([cut]))).toEqual(planAgentReviewPacks(evidence([old])));
    });
});

describe('a recorded plan is used only when it follows from its recorded evidence', () => {
    const e = evidence([subject()]);
    const parsed = () => JSON.parse(JSON.stringify(planAgentReviewPacks(e)));

    it('accepts the plan the evidence implies, and returns the re-derived one', () => {
        expect(checkedPlan(e, parsed())).toEqual(planAgentReviewPacks(e));
    });

    it('refuses, by name, a plan that drops a narrowing, names another agent, or does not parse', () => {
        const dropped = parsed();
        dropped.packs[0].narrowings = [];
        expect(() => checkedPlan(e, dropped)).toThrow(/^PACK_PLAN_MISMATCH:/);
        const other = parsed();
        other.packs[0].agentId = 'ag-other';
        expect(() => checkedPlan(e, other)).toThrow(/^PACK_PLAN_MISMATCH:/);
        expect(() => checkedPlan(e, { packs: 'none' })).toThrow(/^PACK_PLAN_MISMATCH:/);
        expect(() => checkedPlan(e, null)).toThrow(/^PACK_PLAN_MISMATCH:/);
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
            { decisionId: 'dec-1', contentHash: 'sha256:' + 'a'.repeat(64), preparedByRunId: 'run-2', preparedByAgentId: 'ag-2', preparationBasis: 'AGENT_RUN' },
            { decisionId: 'dec-2', contentHash: 'sha256:' + 'b'.repeat(64), preparedByRunId: 'run-1', preparedByAgentId: 'ag-1', preparationBasis: 'AGENT_RUN' },
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
        expect(doc.subjects[0].pack).toEqual({
            contentHash: 'sha256:' + 'a'.repeat(64), preparedByRunId: 'run-2', preparedByAgentId: 'ag-2', preparationBasis: 'AGENT_RUN',
        });
        expect(doc.campaign).toMatchObject({ preparerAgentId: 'ag-1', crossPreparerAgentId: 'ag-2' });
        expect(doc.subjects[0].narrowings.map((n) => [n.id, n.outcome, n.executionResult])).toEqual([
            ['n-1', 'ACCEPTED', 'GRANT_DELETED'],
            ['n-2', 'REJECTED', null],
        ]);
        expect(doc.sample).toEqual({ epoch: 'ar-1@2026-10-20', decisionIds: ['dec-2'] });
        expect(doc.obligations.map((o) => o.requirementCode).sort()).toEqual(['A.5.18', 'ASI03', 'CC6.3']);
    });
});

describe('the evidence says which pack no agent prepared, and why', () => {
    it('a person-prepared self-pack is carried with its basis and no agent', () => {
        const base = rows();
        const doc = buildAgentCampaignEvidence(rows({
            campaign: { ...base.campaign, crossPreparerAgentId: null },
            packs: [
                { decisionId: 'dec-1', contentHash: 'sha256:' + 'a'.repeat(64), preparedByRunId: 'run-2', preparedByAgentId: null, preparationBasis: 'PERSON_STATIC_SELF_PACK' },
                { decisionId: 'dec-2', contentHash: 'sha256:' + 'b'.repeat(64), preparedByRunId: 'run-1', preparedByAgentId: 'ag-1', preparationBasis: 'AGENT_RUN' },
            ],
        }));
        expect(doc.campaign.crossPreparerAgentId).toBeNull();
        expect(doc.subjects[0].pack).toMatchObject({ preparedByAgentId: null, preparationBasis: 'PERSON_STATIC_SELF_PACK' });
        expect(doc.subjects[1].pack).toMatchObject({ preparedByAgentId: 'ag-1', preparationBasis: 'AGENT_RUN' });
    });
});

describe('a person’s static preparation is for the preparer’s own pack only', () => {
    const page = (agents: string[]) => ({ ...evidence(agents.map((a, i) => subject({ decisionId: `dec-${i}`, agentId: a }))) });

    it('accepts exactly the preparer’s subject', () => {
        expect(() => assertStaticRunIsPreparersOwn(page(['ag-1']), 'ag-1')).not.toThrow();
    });

    it('refuses, by name, any other subject, a second subject, or none', () => {
        expect(() => assertStaticRunIsPreparersOwn(page(['ag-2']), 'ag-1')).toThrow(/^STATIC_PACK_NOT_PREPARERS_OWN:/);
        expect(() => assertStaticRunIsPreparersOwn(page(['ag-1', 'ag-2']), 'ag-1')).toThrow(/^STATIC_PACK_NOT_PREPARERS_OWN:/);
        expect(() => assertStaticRunIsPreparersOwn(page([]), 'ag-1')).toThrow(/^STATIC_PACK_NOT_PREPARERS_OWN:/);
    });
});

// ─── The obligations, against the catalogues this repository holds ─────

describe('the evidence is filed against obligations the catalogues actually hold', () => {
    const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

    it('names ISO/IEC 27001 A.5.18, SOC 2 CC6.3 and OWASP ASI03, by family', () => {
        expect(AGENT_RECERT_EVIDENCE_OBLIGATIONS.map((o) => [o.familyUrn, o.requirementCode])).toEqual([
            [ISO27001_FAMILY_URN, 'A.5.18'],
            [SOC2_FAMILY_URN, 'CC6.3'],
            [ASI_LIBRARY_URN, 'ASI03'],
        ]);
    });

    it('SOC 2 CC6.3, which the brief names, is in BOTH representations — asserted, not assumed', () => {
        // THIS TEST USED TO ASSERT THE OPPOSITE, AND THAT IS WHY IT EXISTED.
        // It was written to pin the premise of the CC6.1 substitution: if a
        // catalogue change ever ADDED CC6.3, it would fail and the obligation
        // list would be revisited rather than left understating what the
        // evidence covers. #3369 added it, the test failed, and the list was
        // revisited — so it now pins the presence the substitution needed.
        //
        // Both representations are asserted because they are separate rows and
        // a tenant's controls may hang off either; one alone would leave the
        // other free to drift.
        const library = read('src/data/libraries/soc2-2017.yaml');
        // Comments masked: a seed line commented out is not a seeded code.
        const seed = codeOf(read('prisma/seed-catalog.ts'));
        expect(library).toMatch(/ref_id:\s*CC6\.3\b/);
        expect(seed).toMatch(/code:\s*'CC6\.3'/);
        // CC6 is complete in both, so the whole series resolves rather than
        // just the one code this obligation happens to name. Extracted and
        // compared as LISTS rather than asserted with a built regex per code:
        // a `new RegExp` is opaque to the Class D needle-uniqueness ratchet,
        // which then counts the read as un-analysable, and a list comparison
        // also fails on a code that should not be there rather than only on
        // one that is missing.
        const CC6_SERIES = ['CC6.1', 'CC6.2', 'CC6.3', 'CC6.4', 'CC6.5', 'CC6.6', 'CC6.7', 'CC6.8'];
        const libCc6 = [...library.matchAll(/^\s*ref_id:\s*(CC6\.\d+)\s*$/gm)].map((m) => m[1]);
        const seedCc6 = [...seed.matchAll(/code:\s*'(CC6\.\d+)'/g)].map((m) => m[1]);
        expect(libCc6.sort()).toEqual(CC6_SERIES);
        expect(seedCc6.sort()).toEqual(CC6_SERIES);
        // The note used to be pinned on the string `CC6.3` because it existed to
        // explain a divergence from the brief. There is no divergence now, so
        // what is worth pinning is that the entry still relates itself to the
        // brief rather than standing unexplained.
        const soc2 = AGENT_RECERT_EVIDENCE_OBLIGATIONS.find((o) => o.familyUrn === SOC2_FAMILY_URN);
        expect(soc2?.note).toMatch(/brief/i);
        expect(soc2?.note.length).toBeGreaterThan(30);
    });

    it('A.5.18 is seeded (as 5.18), and ASI03 is in both ASI representations', () => {
        const annexA = JSON.parse(read('prisma/fixtures/iso27001_2022_annexA.json')) as Array<{ key: string }>;
        expect(annexA.some((r) => r.key === '5.18')).toBe(true);
        const asiSeed = JSON.parse(read('prisma/fixtures/owasp_asi_requirements.json')) as Array<{ key: string }>;
        expect(asiSeed.some((r) => r.key === 'ASI03')).toBe(true);
        expect(read('src/data/libraries/owasp-agentic-top10.yaml')).toMatch(/ref_id:\s*ASI03\s*$/m);
    });
});
