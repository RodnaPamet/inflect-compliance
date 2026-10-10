/**
 * Adjudication in the run: what reaches a model, and what is written down.
 *
 * THE SHAPE OF THIS SUITE. Most of it is about paths where NO model answer
 * exists, because those are the ones a deployment actually sits in — the mode
 * is off, no record is committed, no Laya is configured — and each has to leave
 * the queue looking exactly as it would with adjudication off.
 *
 * Every refusal carries a SPY assertion on the provider as well as a row
 * assertion — and it is worth being exact about what each one is worth today,
 * because the two are not interchangeable.
 *
 * **The spy cannot yet discriminate, and the reason is `evaluations/` being
 * empty.** No record is committed for any revision, so `NO_EVALUATION` already
 * stops every call before a payload is built. Remove the kill-switch gate and
 * the spy stays empty — what actually fails is `byReason`, which goes from
 * `KILL_SWITCH` to `NO_EVALUATION`. Verified by mutation, both directions.
 *
 * So the discriminating assertions here are the REASONS, and the spy is a
 * regression net that becomes load-bearing the day a record lands. The
 * hardening checklist asks for a spy proof ("nothing reaches any provider,
 * proven by a spy on every provider"), and that item is not fully satisfiable
 * until a record exists — stating that is more useful than an assertion that
 * passes in both worlds and looks like proof.
 *
 * The factory is mocked so one fake provider can be configured per case. Its
 * real mode-to-provider mapping is covered by
 * `tests/unit/identity-match-provider-factory.test.ts`.
 */

import { PrismaClient } from '@prisma/client';

import { prismaTestClient, resetDatabase } from '../helpers/db';

// ── The provider seam ───────────────────────────────────────────────────────

interface FakeState {
    providerName: 'jev' | 'laya' | 'stub';
    modelName: string;
    seen: string[];
    reply: (tag: string) => unknown;
}

const fake: FakeState = {
    providerName: 'laya',
    modelName: 'laya-multilingual',
    seen: [],
    reply: () => {
        throw new Error('no reply configured');
    },
};

jest.mock('@/app-layer/ai/identity-match', () => ({
    getDecisionProvider: () => ({
        get providerName() {
            return fake.providerName;
        },
        get modelName() {
            return fake.modelName;
        },
        isExternal: false,
        adjudicate: async (state: { account: { username: string } }) => {
            fake.seen.push(state.account.username);
            return fake.reply(state.account.username);
        },
    }),
}));

import { adjudicateResidue } from '@/app-layer/usecases/legacy-adjudication';

const prisma: PrismaClient = prismaTestClient();
const TENANT = 'adj-tenant';

let connectionId: string;
let snapshotId: string;
let executionId: string;
let employeeA: string;
let employeeB: string;

async function clearRuns(): Promise<void> {
    await prisma.legacyMatchVerdict.deleteMany({ where: { tenantId: TENANT } });
    await prisma.aiDecisionLog.deleteMany({ where: { tenantId: TENANT } });
    await prisma.legacyAccountResolution.deleteMany({ where: { tenantId: TENANT } });
}

async function setMode(
    legacyMatchAiMode: 'OFF' | 'LOCAL_ONLY' | 'EXTERNAL' | null,
): Promise<void> {
    if (legacyMatchAiMode === null) {
        await prisma.tenantSecuritySettings.deleteMany({ where: { tenantId: TENANT } });
        return;
    }
    await prisma.tenantSecuritySettings.upsert({
        where: { tenantId: TENANT },
        update: { legacyMatchAiMode, aiResidency: 'LOCAL_ONLY' },
        create: { tenantId: TENANT, legacyMatchAiMode, aiResidency: 'LOCAL_ONLY' },
    });
}

/** One residue resolution with two scored candidates. */
async function residue(
    accountKey: string,
    outcome: 'SUGGESTED' | 'UNMATCHED' | 'LINKED' | 'NON_PERSON',
    candidates: readonly { employeeId: string; score: number }[],
): Promise<string> {
    const row = await prisma.legacyAccountResolution.create({
        data: {
            tenantId: TENANT,
            executionId,
            snapshotId,
            accountKey,
            outcome,
            method: outcome === 'LINKED' ? 'EMAIL_EXACT' : 'NO_STRONG_SIGNAL',
            employeeId: outcome === 'SUGGESTED' ? (candidates[0]?.employeeId ?? null) : null,
            signalsJson: [],
            candidatesJson: candidates as unknown as object,
            vetoesJson: [],
        },
        select: { id: true },
    });
    return row.id;
}

beforeAll(async () => {
    await resetDatabase(prisma);
    await prisma.tenant.upsert({
        where: { id: TENANT },
        update: {},
        create: { id: TENANT, name: 'Adjudication Tenant', slug: TENANT },
    });

    const conn = await prisma.integrationConnection.create({
        data: { tenantId: TENANT, provider: 'legacy-mcp', name: 'legacy', configJson: {} },
        select: { id: true },
    });
    connectionId = conn.id;

    const snap = await prisma.legacyAccessSnapshot.create({
        data: {
            tenantId: TENANT,
            connectionId,
            remoteSnapshotId: 'adj-snap-1',
            mappingVersion: 1,
            columnSetFingerprint: 'f'.repeat(64),
            payloadHash: 'h'.repeat(64),
            rowCount: 1,
            rowsReceived: 1,
            status: 'COMPLETE',
            completedAt: new Date(),
        },
        select: { id: true },
    });
    snapshotId = snap.id;

    const exec = await prisma.integrationExecution.create({
        data: {
            tenantId: TENANT,
            connectionId,
            provider: 'legacy-mcp',
            automationKey: 'legacy-mcp.reconcile',
            status: 'PASSED',
            triggeredBy: 'manual',
            executedAt: new Date(),
        },
        select: { id: true },
    });
    executionId = exec.id;

    const a = await prisma.employee.create({
        data: {
            tenantId: TENANT,
            fullName: 'Ivan Ivanov',
            givenName: 'Ivan',
            familyName: 'Ivanov',
            workEmail: 'ivan.ivanov@corp.test',
            department: 'Finance',
            jobTitle: 'Analyst',
            status: 'ACTIVE',
        },
        select: { id: true },
    });
    const b = await prisma.employee.create({
        data: {
            tenantId: TENANT,
            fullName: 'Petar Petrov',
            givenName: 'Petar',
            familyName: 'Petrov',
            workEmail: 'petar.petrov@corp.test',
            department: 'Finance',
            jobTitle: 'Analyst',
            status: 'ACTIVE',
        },
        select: { id: true },
    });
    employeeA = a.id;
    employeeB = b.id;

    await prisma.legacyAccount.create({
        data: {
            tenantId: TENANT,
            snapshotId,
            accountKey: 'acct-1',
            username: 'i.ivanov',
            displayName: 'Ivanov, Ivan',
            email: 'i.ivanov@legacy.example',
            employeeNumber: 'EMP-FORBIDDEN-1',
            department: 'Finance',
            title: 'Analyst',
            status: 'ACTIVE',
            accountType: 'HUMAN',
            entitlements: ['ENT-FORBIDDEN'],
        },
    });
});

beforeEach(async () => {
    await clearRuns();
    fake.seen = [];
    fake.providerName = 'laya';
    fake.modelName = 'laya-multilingual';
    fake.reply = () => {
        throw new Error('no reply configured');
    };
    await prisma.agentKillSwitch.deleteMany({ where: { tenantId: TENANT } });
    await prisma.platformAgentKillSwitch.deleteMany({});
});

afterAll(async () => {
    await clearRuns();
    await prisma.$disconnect();
});

// ── Adjudication off ────────────────────────────────────────────────────────

describe('adjudication off', () => {
    it('writes NOTHING and calls no provider when the mode is OFF', async () => {
        await setMode('OFF');
        await residue('acct-1', 'SUGGESTED', [{ employeeId: employeeA, score: 9 }]);

        const r = await adjudicateResidue({ tenantId: TENANT, executionId });

        expect(r.ran).toBe(false);
        expect(fake.seen).toEqual([]);
        // No row at all, rather than a row per account saying so: an undecided
        // account must look exactly as it would with adjudication off, and the
        // cheapest way to be sure is for there to be nothing.
        expect(await prisma.legacyMatchVerdict.count({ where: { tenantId: TENANT } })).toBe(0);
    });

    it('writes nothing with NO settings row at all', async () => {
        await setMode(null);
        await residue('acct-1', 'SUGGESTED', [{ employeeId: employeeA, score: 9 }]);

        const r = await adjudicateResidue({ tenantId: TENANT, executionId });

        expect(r.ran).toBe(false);
        expect(fake.seen).toEqual([]);
        expect(await prisma.legacyMatchVerdict.count({ where: { tenantId: TENANT } })).toBe(0);
    });
});

// ── The fail-closed reasons ─────────────────────────────────────────────────

describe('the fail-closed reasons', () => {
    beforeEach(async () => {
        await setMode('LOCAL_ONLY');
    });

    it('a STUB provider is NO_PROVIDER, not PROVIDER_ERROR', async () => {
        // `getDecisionProvider` returns the stub when LOCAL_ONLY is set with no
        // LAYA_BASE_URL. Reporting that as a provider error would describe a
        // deployment that was never configured as a model that misbehaved.
        fake.providerName = 'stub';
        await residue('acct-1', 'SUGGESTED', [
            { employeeId: employeeA, score: 9 },
            { employeeId: employeeB, score: 2 },
        ]);

        const r = await adjudicateResidue({ tenantId: TENANT, executionId });

        expect(r.byReason).toEqual({ NO_PROVIDER: 1 });
        expect(fake.seen).toEqual([]);
        const row = await prisma.legacyMatchVerdict.findFirst({ where: { tenantId: TENANT } });
        expect(row?.nonVerdictReason).toBe('NO_PROVIDER');
        expect(row?.verdict).toBeNull();
    });

    it('NO_EVALUATION when no record is committed for the revision', async () => {
        // `evaluations/` is empty today, which is the designed state: changing a
        // model is a reviewed pull request. So this is the path a configured
        // deployment actually takes.
        await residue('acct-1', 'SUGGESTED', [
            { employeeId: employeeA, score: 9 },
            { employeeId: employeeB, score: 2 },
        ]);

        const r = await adjudicateResidue({ tenantId: TENANT, executionId });

        expect(r.byReason).toEqual({ NO_EVALUATION: 1 });
        expect(fake.seen).toEqual([]);
    });

    it('KILL_SWITCH stops the batch with no model call', async () => {
        await prisma.agentKillSwitch.create({
            data: { tenantId: TENANT, agentId: null, engagedByUserId: 'op-1', reason: 'drill' },
        });
        await residue('acct-1', 'SUGGESTED', [
            { employeeId: employeeA, score: 9 },
            { employeeId: employeeB, score: 2 },
        ]);

        const r = await adjudicateResidue({ tenantId: TENANT, executionId });

        // KILL_SWITCH is checked before the record, so it wins over
        // NO_EVALUATION — the order in the pass is what makes a kill switch a
        // kill switch rather than one more reason among ten.
        expect(r.byReason).toEqual({ KILL_SWITCH: 1 });
        expect(fake.seen).toEqual([]);
    });
});

// ── What is in the residue ──────────────────────────────────────────────────

describe('the residue', () => {
    beforeEach(async () => {
        await setMode('LOCAL_ONLY');
    });

    it('adjudicates SUGGESTED and UNMATCHED, never LINKED or NON_PERSON', async () => {
        await residue('acct-1', 'SUGGESTED', [
            { employeeId: employeeA, score: 9 },
            { employeeId: employeeB, score: 2 },
        ]);
        await residue('acct-2', 'UNMATCHED', [
            { employeeId: employeeA, score: 3 },
            { employeeId: employeeB, score: 2 },
        ]);
        const linked = await residue('acct-3', 'LINKED', [{ employeeId: employeeA, score: 99 }]);
        const nonPerson = await residue('acct-4', 'NON_PERSON', []);

        const r = await adjudicateResidue({ tenantId: TENANT, executionId });

        expect(r.considered).toBe(2);
        const rows = await prisma.legacyMatchVerdict.findMany({
            where: { tenantId: TENANT },
            select: { resolutionId: true },
        });
        const ids = rows.map((x) => x.resolutionId);
        // LINKED was decided by a strong deterministic signal a verdict cannot
        // improve on; NON_PERSON was decided by the non-person rule.
        expect(ids).not.toContain(linked);
        expect(ids).not.toContain(nonPerson);
        expect(ids).toHaveLength(2);
    });

    it('ADJUDICATES an orphan, asking the person question alone', async () => {
        // It used to be skipped, because `NO_CANDIDATES` is not one of the ten
        // storable reasons. Now it is asked — the match question is omitted
        // rather than offered as a one-option choice, so only NOT_A_PERSON and
        // UNSURE are reachable, and NOT_A_PERSON is the valuable one: an
        // account with live access and nobody on the roster is the urgent case.
        await residue('acct-1', 'UNMATCHED', []);

        const r = await adjudicateResidue({ tenantId: TENANT, executionId });

        expect(r.considered).toBe(1);
        // No record is committed, so it gets NO_EVALUATION rather than a
        // verdict — the point here is that it is CONSIDERED at all.
        expect(r.byReason).toEqual({ NO_EVALUATION: 1 });
        expect(await prisma.legacyMatchVerdict.count({ where: { tenantId: TENANT } })).toBe(1);
    });

    it('drops a candidate whose employee row is gone rather than inventing one', async () => {
        // A candidate with an id nothing resolves would be offered to a reviewer
        // as a person. One real candidate remains, so the account is still asked.
        await residue('acct-1', 'SUGGESTED', [
            { employeeId: employeeA, score: 9 },
            { employeeId: 'emp-does-not-exist', score: 8 },
        ]);

        const r = await adjudicateResidue({ tenantId: TENANT, executionId });

        expect(r.considered).toBe(1);
        expect(r.byReason).toEqual({ NO_EVALUATION: 1 });
    });
});

// ── The row, and its decision-log twin ──────────────────────────────────────

describe('what gets written', () => {
    beforeEach(async () => {
        await setMode('LOCAL_ONLY');
    });

    it('stores the non-verdict reason with no probabilities', async () => {
        await residue('acct-1', 'SUGGESTED', [
            { employeeId: employeeA, score: 9 },
            { employeeId: employeeB, score: 2 },
        ]);

        await adjudicateResidue({ tenantId: TENANT, executionId });

        const row = await prisma.legacyMatchVerdict.findFirstOrThrow({
            where: { tenantId: TENANT },
        });
        expect(row.nonVerdictReason).toBe('NO_EVALUATION');
        expect(row.verdict).toBeNull();
        expect(row.probabilitiesJson).toBeNull();
        expect(row.topProbability).toBeNull();
    });

    it('stores the labelling, so a letter can be resolved to a person', async () => {
        // Without this a PROPOSES verdict says "the model picked C" and nothing
        // in the row can say who C was.
        await residue('acct-1', 'SUGGESTED', [
            { employeeId: employeeA, score: 9 },
            { employeeId: employeeB, score: 2 },
        ]);

        await adjudicateResidue({ tenantId: TENANT, executionId });

        const row = await prisma.legacyMatchVerdict.findFirstOrThrow({
            where: { tenantId: TENANT },
        });
        const labelling = row.labellingJson as Record<string, string> | null;
        expect(labelling).not.toBeNull();
        // Both candidates, each under a letter, and the letters are a gapless
        // prefix of A-E.
        expect(Object.keys(labelling ?? {}).sort()).toEqual(['A', 'B']);
        expect(Object.values(labelling ?? {}).sort()).toEqual([employeeA, employeeB].sort());
    });

    it('writes one AiDecisionLog row per verdict, keyed to it by sessionRef', async () => {
        await residue('acct-1', 'SUGGESTED', [
            { employeeId: employeeA, score: 9 },
            { employeeId: employeeB, score: 2 },
        ]);

        await adjudicateResidue({ tenantId: TENANT, executionId });

        const verdict = await prisma.legacyMatchVerdict.findFirstOrThrow({
            where: { tenantId: TENANT },
        });
        const log = await prisma.aiDecisionLog.findFirstOrThrow({
            where: { tenantId: TENANT, feature: 'legacy-identity-match' },
        });
        // `sessionRef` IS the verdict id, which is what lets a reviewer's
        // decision stamp exactly this row through `recordDecisionOutcome`.
        expect(log.sessionRef).toBe(verdict.id);
        expect(log.provider).toBe('laya');
    });

    it('never stores the payload, only a digest of it', async () => {
        await residue('acct-1', 'SUGGESTED', [
            { employeeId: employeeA, score: 9 },
            { employeeId: employeeB, score: 2 },
        ]);

        await adjudicateResidue({ tenantId: TENANT, executionId });

        const log = await prisma.aiDecisionLog.findFirstOrThrow({
            where: { tenantId: TENANT, feature: 'legacy-identity-match' },
        });
        const serialised = JSON.stringify(log);
        // A legacy display name is personal data, and an AiDecisionLog row is
        // not the place for it. The forbidden fields must not be there either.
        expect(serialised).not.toContain('Ivanov, Ivan');
        expect(serialised).not.toContain('EMP-FORBIDDEN-1');
        expect(serialised).not.toContain('legacy.example');
        expect(log.inputDigest).toBeTruthy();
    });

    it('is immutable: a second pass under the same revision adds no second row', async () => {
        await residue('acct-1', 'SUGGESTED', [
            { employeeId: employeeA, score: 9 },
            { employeeId: employeeB, score: 2 },
        ]);

        await adjudicateResidue({ tenantId: TENANT, executionId });
        const first = await prisma.legacyMatchVerdict.findFirstOrThrow({
            where: { tenantId: TENANT },
        });

        const second = await adjudicateResidue({ tenantId: TENANT, executionId });

        // A re-run under the same revision is the SAME question, and the unique
        // on (resolutionId, modelRevision) refuses to answer it twice. The
        // second pass reports zero written rather than throwing — one row
        // failing must not discard the others.
        expect(second.written).toBe(0);
        const rows = await prisma.legacyMatchVerdict.findMany({ where: { tenantId: TENANT } });
        expect(rows).toHaveLength(1);
        expect(rows[0].createdAt).toEqual(first.createdAt);
    });
});
