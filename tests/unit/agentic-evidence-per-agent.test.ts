/**
 * Per-agent evidence (#3700) — the pure half: the kinds, the obligations, the
 * digest, the body, and the withdrawal notice.
 *
 * Two properties carry the step, and this file holds the one a database test
 * cannot isolate: that adding per-agent artefacts left every TENANT-WIDE digest
 * and body byte-for-byte what it was. The golden values below were computed by
 * the builders as they stood on main before #3700 (e81c933b2), over a fixed
 * population, and a tenant-wide artefact re-emitted after this change must
 * still say exactly that — otherwise every tenant's August artefact "changed"
 * on the morning of the deploy, with nothing in its population having moved.
 *
 * The other half — that a per-agent artefact counts only its own agent and that
 * retirement withdraws it — is in `tests/integration/agentic-evidence-per-agent.test.ts`,
 * because it is a claim about rows.
 */
import * as fs from 'fs';
import { createHash } from 'crypto';

import {
    AGENTIC_ARTEFACT_KINDS,
    ARTEFACT_KIND_DECISIONS,
    ARTEFACT_KIND_DECISIONS_PER_AGENT,
    ARTEFACT_KIND_HARNESS_SCANS,
    ARTEFACT_KIND_PASSPORTS,
    ARTEFACT_KIND_RECEIPTS,
    ARTEFACT_KIND_RECEIPTS_PER_AGENT,
    ARTEFACT_WITHDRAWAL_REASONS,
    PER_AGENT_ARTEFACT_KINDS,
    buildAgentDecisionArtefact,
    buildAgentReceiptArtefact,
    buildDecisionArtefact,
    buildReceiptArtefact,
    buildWithdrawalNotice,
    isPerAgentKind,
    monthlyPeriod,
    perAgentPopulationDigest,
    sourcePopulationDigest,
    targetsForKind,
    type DecisionFact,
    type ReceiptFact,
} from '@/lib/agentic/evidence-artefact';
import { repoFiles } from '../helpers/repo-files';

const PERIOD = monthlyPeriod(new Date('2026-10-14T09:00:00.000Z'));

const RECEIPTS: ReceiptFact[] = [
    { id: 'rcpt-a', toolName: 'list_risks', decisionVerdict: 'allow', verified: true, auditLogId: 'audit-a', toolProvenance: 'inflect:builtin' },
    { id: 'rcpt-b', toolName: 'propose_risks', decisionVerdict: 'block', verified: false, auditLogId: null, toolProvenance: 'unattested' },
    { id: 'rcpt-c', toolName: 'list_risks', decisionVerdict: 'allow', verified: true, auditLogId: null, toolProvenance: null },
];
const DECISIONS: DecisionFact[] = [
    { id: 'dec-a', feature: 'agent-proposal', provider: 'mcp-agent', guardVerdict: 'PASS', humanOutcome: 'ACCEPTED' },
    { id: 'dec-b', feature: 'agentic-run:model', provider: 'anthropic', guardVerdict: null, humanOutcome: 'PENDING' },
    { id: 'dec-c', feature: 'agentic-tool:external', provider: 'mcp:conn-1', guardVerdict: null, humanOutcome: 'AUTONOMOUS' },
];

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('the tenant-wide artefacts are byte-for-byte what they were before #3700', () => {
    // Computed on e81c933b2 by these same calls. Do not regenerate them to make
    // this pass: a moved value means every tenant-wide artefact in production
    // would be rewritten on its next tick with an unchanged population.
    const GOLDEN = {
        receiptDigest: 'ad5f3c11a4d0f1d2396fc492effa809a9419c3ff7789affbf012dd6274a75ba8',
        decisionDigest: 'c12a53ddd6f10615c1fff44aef2c90f3b333defd250f6e02f53abe2b68d5c7b7',
        receiptTitle: 'Agent action receipts — 2026-10',
        receiptContentSha256: 'fe77f10bfb5376156db19abd2190f67564880e3f0faf25ba1937897be82bb9e5',
        decisionTitle: 'AI decision records (EU AI Act Art 12) — 2026-10',
        decisionContentSha256: 'a89ad593b7e6352a305facf5c869bf5ffa46e47cffe755fa60d115c04e44999d',
    };

    it('keeps the receipt digest and body', () => {
        const digest = sourcePopulationDigest(ARTEFACT_KIND_RECEIPTS, PERIOD.start, RECEIPTS);
        expect(digest).toBe(GOLDEN.receiptDigest);
        const body = buildReceiptArtefact(PERIOD, RECEIPTS, digest);
        expect(body.title).toBe(GOLDEN.receiptTitle);
        expect(sha256(body.content)).toBe(GOLDEN.receiptContentSha256);
    });

    it('keeps the decision digest and body', () => {
        const digest = sourcePopulationDigest(ARTEFACT_KIND_DECISIONS, PERIOD.start, DECISIONS);
        expect(digest).toBe(GOLDEN.decisionDigest);
        const body = buildDecisionArtefact(PERIOD, DECISIONS, digest);
        expect(body.title).toBe(GOLDEN.decisionTitle);
        expect(sha256(body.content)).toBe(GOLDEN.decisionContentSha256);
    });

    it('keeps a tenant-wide withdrawal notice unchanged when no agent is named', () => {
        const at = new Date('2026-10-18T06:30:00.000Z');
        const notice = buildWithdrawalNotice(PERIOD, 'CONTROL_REMOVED', at, 'd'.repeat(64));
        expect(notice).toBe(buildWithdrawalNotice(PERIOD, 'CONTROL_REMOVED', at, 'd'.repeat(64), null));
        expect(notice).not.toContain('Agent:');
    });
});

describe('the per-agent kinds', () => {
    it('are known kinds, and exactly the two that name an agent', () => {
        expect(PER_AGENT_ARTEFACT_KINDS).toEqual([ARTEFACT_KIND_RECEIPTS_PER_AGENT, ARTEFACT_KIND_DECISIONS_PER_AGENT]);
        for (const kind of PER_AGENT_ARTEFACT_KINDS) expect(AGENTIC_ARTEFACT_KINDS).toContain(kind);
        expect(AGENTIC_ARTEFACT_KINDS.filter(isPerAgentKind)).toEqual([...PER_AGENT_ARTEFACT_KINDS]);
        for (const kind of [ARTEFACT_KIND_RECEIPTS, ARTEFACT_KIND_DECISIONS, ARTEFACT_KIND_HARNESS_SCANS, ARTEFACT_KIND_PASSPORTS]) {
            expect(isPerAgentKind(kind)).toBe(false);
        }
        expect(isPerAgentKind('NOT_A_KIND')).toBe(false);
    });

    it.each([
        [ARTEFACT_KIND_RECEIPTS_PER_AGENT, ARTEFACT_KIND_RECEIPTS],
        [ARTEFACT_KIND_DECISIONS_PER_AGENT, ARTEFACT_KIND_DECISIONS],
    ] as const)('%s evidences exactly the obligations %s does', (perAgent, tenantWide) => {
        // Same obligations, so an agent's artefacts land on exactly the controls
        // the tenant's do, and an obligation unmapped from one is unmapped from
        // both by the same withdrawal sweep.
        const key = (kind: typeof perAgent | typeof tenantWide) =>
            targetsForKind(kind)
                .map((t) => `${t.familyUrn}#${t.requirementCode}`)
                .sort();
        expect(key(perAgent)).toEqual(key(tenantWide));
        expect(key(perAgent).length).toBeGreaterThan(0);
    });
});

describe('a per-agent digest is bound to its agent', () => {
    it('differs between two agents with the same population', () => {
        const a = perAgentPopulationDigest(ARTEFACT_KIND_RECEIPTS_PER_AGENT, PERIOD.start, 'agent-a', RECEIPTS, false);
        const b = perAgentPopulationDigest(ARTEFACT_KIND_RECEIPTS_PER_AGENT, PERIOD.start, 'agent-b', RECEIPTS, false);
        expect(a).not.toBe(b);
        // And for the empty population too — the case two agents most often share.
        expect(perAgentPopulationDigest(ARTEFACT_KIND_DECISIONS_PER_AGENT, PERIOD.start, 'agent-a', [], false)).not.toBe(
            perAgentPopulationDigest(ARTEFACT_KIND_DECISIONS_PER_AGENT, PERIOD.start, 'agent-b', [], false),
        );
    });

    it('never equals the tenant-wide digest of the same facts', () => {
        expect(perAgentPopulationDigest(ARTEFACT_KIND_RECEIPTS_PER_AGENT, PERIOD.start, 'agent-a', RECEIPTS, false)).not.toBe(
            sourcePopulationDigest(ARTEFACT_KIND_RECEIPTS, PERIOD.start, RECEIPTS),
        );
    });

    it('moves when the read stops at its bound, because the body says so', () => {
        expect(perAgentPopulationDigest(ARTEFACT_KIND_RECEIPTS_PER_AGENT, PERIOD.start, 'agent-a', RECEIPTS, true)).not.toBe(
            perAgentPopulationDigest(ARTEFACT_KIND_RECEIPTS_PER_AGENT, PERIOD.start, 'agent-a', RECEIPTS, false),
        );
    });

    it('does not depend on row order', () => {
        const reversed = [...RECEIPTS].reverse();
        expect(perAgentPopulationDigest(ARTEFACT_KIND_RECEIPTS_PER_AGENT, PERIOD.start, 'agent-a', reversed, false)).toBe(
            perAgentPopulationDigest(ARTEFACT_KIND_RECEIPTS_PER_AGENT, PERIOD.start, 'agent-a', RECEIPTS, false),
        );
    });
});

describe('a per-agent body', () => {
    it('is the tenant-wide body over the agent\'s facts, under a preamble naming the agent and the attribution', () => {
        const digest = perAgentPopulationDigest(ARTEFACT_KIND_RECEIPTS_PER_AGENT, PERIOD.start, 'agent-a', RECEIPTS, false);
        const body = buildAgentReceiptArtefact(PERIOD, 'agent-a', RECEIPTS, digest, false);
        expect(body.title).toBe('Agent action receipts — agent agent-a — 2026-10');
        // One description of a receipt, not two that could drift.
        expect(body.content.endsWith(buildReceiptArtefact(PERIOD, RECEIPTS, digest).content)).toBe(true);
        expect(body.content).toMatch(/^Agent: agent-a \(agent register id\)\n/);
        expect(body.content).toContain('submitted with an API key bound to this agent');
        expect(body.content).toContain('counted in the tenant-wide artefact');
        expect(body.content).not.toContain('BOUNDED');
    });

    it('says when the population read stopped at its bound', () => {
        const digest = perAgentPopulationDigest(ARTEFACT_KIND_DECISIONS_PER_AGENT, PERIOD.start, 'agent-a', DECISIONS, true);
        const body = buildAgentDecisionArtefact(PERIOD, 'agent-a', DECISIONS, digest, true);
        expect(body.title).toBe('AI decision records (EU AI Act Art 12) — agent agent-a — 2026-10');
        expect(body.content.endsWith(buildDecisionArtefact(PERIOD, DECISIONS, digest).content)).toBe(true);
        expect(body.content).toContain('BOUNDED:');
    });
});

describe('AGENT_RETIRED', () => {
    it('is a withdrawal reason with a notice that names the agent and keeps the closed periods', () => {
        const at = new Date('2026-10-18T12:00:00.000Z');
        const notice = buildWithdrawalNotice(PERIOD, 'AGENT_RETIRED', at, 'd'.repeat(64), 'agent-a');
        expect(notice.split('\n')[0]).toBe('WITHDRAWN 2026-10-18T12:00:00.000Z — AGENT_RETIRED');
        expect(notice).toContain('Agent: agent-a');
        expect(notice).toContain('was retired while the period was still open');
        expect(notice).toContain('closed periods are kept');
        expect(notice).toContain(`Superseded population digest: ${'d'.repeat(64)}`);
    });

    it('is listed by the newest migration that re-creates the reason CHECK, with every older reason', () => {
        // The CHECK is DROP + ADD in each migration that widens it, so the one
        // that sorts LAST is in force — and must re-list every reason, or its
        // ADD fails against rows already withdrawn for one it left out.
        const migrations = repoFiles({ under: 'prisma/migrations', extensions: ['.sql'] })
            .filter((f) => fs.readFileSync(f, 'utf8').includes('"AgenticEvidenceArtefact_withdrawn_reason_known"'))
            .sort();
        const newest = fs.readFileSync(migrations[migrations.length - 1], 'utf8')
            .split('\n')
            .filter((line) => !line.trim().startsWith('--'))
            .join('\n');
        const check = /ADD CONSTRAINT "AgenticEvidenceArtefact_withdrawn_reason_known"[\s\S]*?IN \(([^)]*)\)/.exec(newest);
        expect(check).not.toBeNull();
        const allowed = check![1].split(',').map((k) => k.trim().replace(/^'|'$/g, '')).sort();
        expect(allowed).toEqual([...ARTEFACT_WITHDRAWAL_REASONS].sort());
    });
});
