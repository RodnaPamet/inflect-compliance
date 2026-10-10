/**
 * Step 4b: the reviewer actions, and what the server refuses to take on trust.
 *
 * The hardening list for this step is mostly about REFUSALS, so most of what is
 * below asserts that something does not happen. Each refusal has its own test
 * rather than sharing one, because they fail for different reasons and a shared
 * assertion would pass on the wrong one.
 */
import { PrismaClient } from '@prisma/client';
import { prismaTestClient, resetDatabase } from '../helpers/db';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { makeRequestContext } from '../helpers/make-context';
import { getPermissionsForRole } from '@/lib/permissions';
import { isBlindHeld } from '@/lib/legacy-access/blind-sample';
import {
    BULK_MAX_ROWS,
    BULK_MIN_MARGIN,
    bulkConfirmLegacyAccounts,
    candidateMargin,
    decideLegacyAccount,
    listExpiredExternals,
    listReconciliationQueue,
} from '@/app-layer/usecases/legacy-reviewer-actions';

const prisma: PrismaClient = prismaTestClient();

const T1 = 'lra-tenant';
const T2 = 'lra-other';
const ctx = (role = 'ADMIN') => makeRequestContext(role, { tenantId: T1 });

let connectionId = '';
let snapshotId = '';
let executionId = '';
let employeeId = '';
let otherTenantEmployeeId = '';

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: [T1, T2] } };
    await prisma.legacyIdentityAlias.deleteMany({ where: t });
    await prisma.legacyAccountResolution.deleteMany({ where: t });
    await prisma.legacyAccessSnapshot.deleteMany({ where: t });
    await prisma.integrationExecution.deleteMany({ where: t });
    await prisma.tenantMembership.deleteMany({ where: t });
    await prisma.employee.deleteMany({ where: t });
    await prisma.integrationConnection.deleteMany({ where: t });
    await deleteAuditRowsForTenants(prisma, [T1, T2]);
}

/** One resolution for `accountKey`, in a NEW execution. Returns its id. */
async function seedResolution(opts: {
    accountKey: string;
    outcome: 'SUGGESTED' | 'AMBIGUOUS' | 'UNMATCHED' | 'LINKED';
    candidates: { employeeId: string; score: number }[];
}): Promise<string> {
    const exec = await prisma.integrationExecution.create({
        data: {
            tenantId: T1, connectionId, status: 'PASSED',
            provider: 'legacy-mcp', automationKey: 'legacy-reconcile',
            executedAt: new Date(), completedAt: new Date(),
        },
    });
    await prisma.legacyAccountResolution.create({
        data: {
            tenantId: T1,
            executionId: exec.id,
            snapshotId,
            accountKey: opts.accountKey,
            outcome: opts.outcome,
            method: opts.outcome === 'SUGGESTED' ? 'SUPPORTING_ONLY' : 'NO_CANDIDATES',
            employeeId: null,
            signalsJson: [{ kind: 'SIMILARITY', score: 120, evidence: '0.910' }],
            candidatesJson: opts.candidates.map((c) => ({
                employeeId: c.employeeId, score: c.score, signals: [], vetoes: [], strongest: 'SUPPORTING',
            })),
            vetoesJson: [],
        },
    });
    return exec.id;
}

beforeAll(async () => {
    await resetDatabase(prisma);
    await clearOwnRows();
    for (const [id, name] of [[T1, 'Tenant One'], [T2, 'Tenant Two']] as const) {
        await prisma.tenant.upsert({ where: { id }, update: {}, create: { id, name, slug: id } });
    }
    await prisma.user.upsert({
        where: { id: 'user-1' }, update: {},
        create: { id: 'user-1', email: 'reviewer@lra.test', name: 'Reviewer' },
    });
    await prisma.user.upsert({
        where: { id: 'user-owner' }, update: {},
        create: { id: 'user-owner', email: 'owner@lra.test', name: 'Service Owner' },
    });
});

beforeEach(async () => {
    await clearOwnRows();
    connectionId = (await prisma.integrationConnection.create({
        data: { tenantId: T1, provider: 'legacy-mcp', name: 'legacy', configJson: {} },
    })).id;
    snapshotId = (await prisma.legacyAccessSnapshot.create({
        data: {
            tenantId: T1, connectionId, remoteSnapshotId: 'snap-1', mappingVersion: 1,
            columnSetFingerprint: 'f'.repeat(64), payloadHash: 'h'.repeat(64),
            rowCount: 1, rowsReceived: 1, status: 'COMPLETE', completedAt: new Date(),
        },
    })).id;
    employeeId = (await prisma.employee.create({
        data: {
            tenantId: T1, fullName: 'Ada Lovelace', givenName: 'Ada', familyName: 'Lovelace',
            workEmail: 'ada@lra.test', status: 'ACTIVE',
        },
    })).id;
    otherTenantEmployeeId = (await prisma.employee.create({
        data: {
            tenantId: T2, fullName: 'Grace Hopper', givenName: 'Grace', familyName: 'Hopper',
            workEmail: 'grace@lra.test', status: 'ACTIVE',
        },
    })).id;
    await prisma.tenantMembership.create({
        data: { tenantId: T1, userId: 'user-owner', role: 'ADMIN' },
    });
    executionId = await seedResolution({
        accountKey: 'alovelace', outcome: 'SUGGESTED',
        candidates: [{ employeeId, score: 500 }],
    });
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

const alias = () =>
    prisma.legacyIdentityAlias.findFirstOrThrow({
        where: { tenantId: T1, connectionId, accountKey: 'alovelace' },
    });

describe('authorisation', () => {
    it('a role without the confirm key is denied', async () => {
        await expect(
            decideLegacyAccount(ctx('READER'), {
                connectionId, accountKey: 'alovelace', executionId,
                action: { kind: 'CONFIRM', employeeId },
            })
        ).rejects.toThrow(/identity_reconciliation.confirm/);
    });

    it('a CUSTOM role granting confirm over a READER base is ALLOWED', async () => {
        // The reason this usecase reads the granular key rather than
        // `canAdmin`: a custom role can grant confirm on a READER base, whose
        // `canAdmin` is false. A coarse check would refuse what the route
        // allowed, and the custom role would be unusable.
        const custom = makeRequestContext('READER', {
            tenantId: T1,
            appPermissions: {
                ...getPermissionsForRole('READER'),
                identity_reconciliation: { view: true, confirm: true },
            },
        });
        expect(custom.permissions.canAdmin).toBe(false);

        const r = await decideLegacyAccount(custom, {
            connectionId, accountKey: 'alovelace', executionId,
            action: { kind: 'CONFIRM', employeeId },
        });
        expect(r.outcome).toBe('WRITTEN');
    });

    it('viewing the queue needs only the view key', async () => {
        const q = await listReconciliationQueue(ctx('READER'), { executionId, connectionId });
        expect(q.map((x) => x.accountKey)).toEqual(['alovelace']);
    });
});

describe('the server re-checks what the client claims', () => {
    it('refuses a confirmation against a SUPERSEDED result with 409', async () => {
        const stale = executionId;
        // A newer run for the same account. Results are immutable, so this ADDS.
        await seedResolution({
            accountKey: 'alovelace', outcome: 'SUGGESTED',
            candidates: [{ employeeId, score: 500 }],
        });

        await expect(
            decideLegacyAccount(ctx(), {
                connectionId, accountKey: 'alovelace', executionId: stale,
                action: { kind: 'CONFIRM', employeeId },
            })
        ).rejects.toThrow(/replaced by a newer run/);
    });

    it('refuses CONFIRM for an employee the engine never scored', async () => {
        const unscored = await prisma.employee.create({
            data: {
                tenantId: T1, fullName: 'Someone Else', status: 'ACTIVE',
                workEmail: 'else@lra.test',
            },
        });
        await expect(
            decideLegacyAccount(ctx(), {
                connectionId, accountKey: 'alovelace', executionId,
                action: { kind: 'CONFIRM', employeeId: unscored.id },
            })
        ).rejects.toThrow(/not among the candidates/);
    });

    it('refuses an employee from ANOTHER tenant, even via MANUAL', async () => {
        await expect(
            decideLegacyAccount(ctx(), {
                connectionId, accountKey: 'alovelace', executionId,
                action: {
                    kind: 'MANUAL', employeeId: otherTenantEmployeeId,
                    justification: 'they transferred from the other org last year',
                },
            })
        ).rejects.toThrow(/no employee/);
    });
});

describe('each action writes what it claims', () => {
    it('CONFIRM writes an EMPLOYEE alias with method CONFIRMED_ALIAS', async () => {
        await decideLegacyAccount(ctx(), {
            connectionId, accountKey: 'alovelace', executionId,
            action: { kind: 'CONFIRM', employeeId },
        });
        const a = await alias();
        expect(a.classification).toBe('EMPLOYEE');
        expect(a.employeeId).toBe(employeeId);
        expect(a.method).toBe('CONFIRMED_ALIAS');
        expect(a.justification).toBeNull();
    });

    it('MANUAL accepts an unscored employee, and records the reason', async () => {
        const unscored = await prisma.employee.create({
            data: { tenantId: T1, fullName: 'Not Suggested', status: 'ACTIVE', workEmail: 'ns@lra.test' },
        });
        await decideLegacyAccount(ctx(), {
            connectionId, accountKey: 'alovelace', executionId,
            action: {
                kind: 'MANUAL', employeeId: unscored.id,
                justification: 'confirmed verbally with their line manager on the 8th',
            },
        });
        const a = await alias();
        expect(a.method).toBe('MANUAL');
        expect(a.employeeId).toBe(unscored.id);
        // Stored AND ENCRYPTED. The raw test client does not decrypt, so what
        // comes back is ciphertext — which is the stronger assertion to make
        // here: matching the plaintext would pass just as well if the manifest
        // entry were missing and the reviewer's words were sitting in the clear.
        expect(a.justification).not.toBeNull();
        expect(a.justification).toMatch(/^v\d+:/);
        expect(a.justification).not.toContain('line manager');
    });

    it('NON_PERSON requires an owner who is a member of THIS tenant', async () => {
        await expect(
            decideLegacyAccount(ctx(), {
                connectionId, accountKey: 'alovelace', executionId,
                action: {
                    kind: 'NON_PERSON', ownerUserId: 'user-1',
                    justification: 'batch job for the nightly export',
                },
            })
        ).rejects.toThrow(/member of this tenant/);

        // The denominator: with a real member it succeeds, so the refusal above
        // is the membership check rather than something else failing first.
        const r = await decideLegacyAccount(ctx(), {
            connectionId, accountKey: 'alovelace', executionId,
            action: {
                kind: 'NON_PERSON', ownerUserId: 'user-owner',
                justification: 'batch job for the nightly export',
            },
        });
        expect(r.classification).toBe('NON_PERSON');
        expect((await alias()).employeeId).toBeNull();
    });

    it('EXTERNAL refuses an expiry in the past', async () => {
        await expect(
            decideLegacyAccount(ctx(), {
                connectionId, accountKey: 'alovelace', executionId,
                action: {
                    kind: 'EXTERNAL',
                    justification: 'external auditor for the ISO engagement',
                    expiresAt: new Date(Date.now() - 86_400_000),
                },
            })
        ).rejects.toThrow(/expiry in the future/);
    });

    it.each(['MANUAL', 'NON_PERSON', 'EXTERNAL', 'ORPHAN'] as const)(
        '%s refuses a justification that sanitises to nothing',
        async (kind) => {
            // Length is checked AFTER sanitising. A reason made entirely of
            // markup would otherwise pass a raw length check and store empty.
            const markup = '<b></b><i></i><span></span><em></em>';
            const action =
                kind === 'MANUAL' ? { kind, employeeId, justification: markup }
                : kind === 'NON_PERSON' ? { kind, ownerUserId: 'user-owner', justification: markup }
                : kind === 'EXTERNAL'
                    ? { kind, justification: markup, expiresAt: new Date(Date.now() + 86_400_000) }
                    : { kind, justification: markup };

            await expect(
                decideLegacyAccount(ctx(), {
                    connectionId, accountKey: 'alovelace', executionId,
                    action: action as never,
                })
            ).rejects.toThrow(/justification of at least/);
        }
    );

    it('DEFER writes no alias, but does write an audit row', async () => {
        const r = await decideLegacyAccount(ctx(), {
            connectionId, accountKey: 'alovelace', executionId,
            action: { kind: 'DEFER' },
        });
        expect(r.outcome).toBe('DEFERRED');
        expect(
            await prisma.legacyIdentityAlias.count({ where: { tenantId: T1 } })
        ).toBe(0);
        // "Nobody looked at this" and "somebody looked and could not decide"
        // are different facts about a queue.
        const audits = await prisma.auditLog.count({
            where: { tenantId: T1, action: 'LEGACY_RECONCILIATION_DEFERRED' },
        });
        expect(audits).toBe(1);
    });

    it('a re-decision UPDATES the standing answer and clears a suspension', async () => {
        await decideLegacyAccount(ctx(), {
            connectionId, accountKey: 'alovelace', executionId,
            action: { kind: 'CONFIRM', employeeId },
        });
        await prisma.legacyIdentityAlias.updateMany({
            where: { tenantId: T1, accountKey: 'alovelace' },
            data: { status: 'SUSPENDED', suspendedReason: 'HR_RECORD_VANISHED', suspendedAt: new Date() },
        });

        await decideLegacyAccount(ctx(), {
            connectionId, accountKey: 'alovelace', executionId,
            action: { kind: 'ORPHAN', justification: 'nobody in the team recognises this login' },
        });

        const a = await alias();
        expect(a.classification).toBe('ORPHAN');
        expect(a.employeeId).toBeNull();
        expect(a.status).toBe('ACTIVE');
        expect(a.suspendedReason).toBeNull();
        expect(await prisma.legacyIdentityAlias.count({ where: { tenantId: T1 } })).toBe(1);
    });
});

describe('the audit row records what the reviewer was shown', () => {
    it('carries the engine signals and the resolution outcome', async () => {
        await decideLegacyAccount(ctx(), {
            connectionId, accountKey: 'alovelace', executionId,
            action: { kind: 'CONFIRM', employeeId },
        });
        const row = await prisma.auditLog.findFirstOrThrow({
            where: { tenantId: T1, action: 'LEGACY_RECONCILIATION_DECIDED' },
        });
        const d = row.detailsJson as Record<string, unknown>;
        expect(d.resolutionOutcome).toBe('SUGGESTED');
        expect(JSON.stringify(d.signals)).toContain('SIMILARITY');
        expect(d.classification).toBe('EMPLOYEE');
    });

    it('does NOT copy the justification into the audit row', async () => {
        // It is encrypted on the alias row. Copying the plaintext into an audit
        // row would put it somewhere the encryption manifest does not cover.
        await decideLegacyAccount(ctx(), {
            connectionId, accountKey: 'alovelace', executionId,
            action: { kind: 'ORPHAN', justification: 'SENTINELPHRASE nobody recognises this login' },
        });
        const row = await prisma.auditLog.findFirstOrThrow({
            where: { tenantId: T1, action: 'LEGACY_RECONCILIATION_DECIDED' },
        });
        expect(JSON.stringify(row.detailsJson)).not.toContain('SENTINELPHRASE');
        expect(row.details).not.toContain('SENTINELPHRASE');
        expect((row.detailsJson as Record<string, unknown>).hasJustification).toBe(true);
    });
});

describe('bulk confirmation', () => {
    it('the margin of a sole candidate is Infinity, not its score', async () => {
        // A sole candidate is unopposed, not "ahead by its score". Treating the
        // two alike would fail a weak sole candidate that a strong one passes,
        // which is backwards — the sole candidate is the LESS ambiguous row.
        expect(candidateMargin([{ employeeId: 'e', score: 1, signals: [], vetoes: [], strongest: null }]))
            .toBe(Number.POSITIVE_INFINITY);
        expect(candidateMargin([])).toBe(0);
    });

    it('refuses more rows than the cap', async () => {
        const rows = Array.from({ length: BULK_MAX_ROWS + 1 }, (_, i) => ({
            accountKey: `a${i}`, employeeId,
        }));
        await expect(
            bulkConfirmLegacyAccounts(ctx(), { connectionId, executionId, rows })
        ).rejects.toThrow(/capped at/);
    });

    it('reports failures PER ROW rather than failing the request', async () => {
        const tight = await seedResolution({
            accountKey: 'tight', outcome: 'SUGGESTED',
            // Two candidates a hair apart — under the margin.
            candidates: [{ employeeId, score: 500 }, { employeeId, score: 500 - (BULK_MIN_MARGIN - 1) }],
        });
        const out = await bulkConfirmLegacyAccounts(ctx(), {
            connectionId, executionId: tight,
            rows: [{ accountKey: 'tight', employeeId }, { accountKey: 'missing', employeeId }],
        });
        expect(out).toHaveLength(2);
        expect(out[0]).toMatchObject({ accountKey: 'tight', ok: false });
        expect(out[0].reason).toMatch(/margin/);
        expect(out[1]).toMatchObject({ accountKey: 'missing', ok: false });
    });

    it('refuses an AMBIGUOUS row even when its margin would pass', async () => {
        const amb = await seedResolution({
            accountKey: 'ambig', outcome: 'AMBIGUOUS',
            candidates: [{ employeeId, score: 900 }],
        });
        const out = await bulkConfirmLegacyAccounts(ctx(), {
            connectionId, executionId: amb, rows: [{ accountKey: 'ambig', employeeId }],
        });
        expect(out[0].ok).toBe(false);
        expect(out[0].reason).toMatch(/only SUGGESTED/);
    });

    it('confirms a clear SUGGESTED row through the SAME path as a single decision', async () => {
        const out = await bulkConfirmLegacyAccounts(ctx(), {
            connectionId, executionId, rows: [{ accountKey: 'alovelace', employeeId }],
        });
        expect(out[0]).toEqual({ accountKey: 'alovelace', ok: true, reason: null });
        const a = await alias();
        expect(a.classification).toBe('EMPLOYEE');
        expect(a.method).toBe('CONFIRMED_ALIAS');
    });
});

describe('the queue stops asking once a reviewer has answered', () => {
    const queue = (now?: Date) =>
        listReconciliationQueue(ctx(), { executionId, connectionId, ...(now ? { now } : {}) });

    it('an UNDECIDED account is in the queue, labelled as such', async () => {
        const q = await queue();
        expect(q).toHaveLength(1);
        expect(q[0]).toMatchObject({ accountKey: 'alovelace', reason: 'UNDECIDED' });
        expect(q[0].expiredAt).toBeNull();
    });

    it.each(['NON_PERSON', 'EXTERNAL', 'ORPHAN'] as const)(
        'a %s decision removes it — without this the reviewer is asked again every run',
        async (kind) => {
            // The defect this guards: readAliases feeds the engine EMPLOYEE
            // aliases only, so these three resolve UNMATCHED for ever. A queue
            // built from resolutions alone undoes the reviewer's work every
            // cycle — classify forty service accounts, and the next run asks
            // about all forty.
            const action =
                kind === 'NON_PERSON'
                    ? { kind, ownerUserId: 'user-owner', justification: 'nightly export batch job' }
                    : kind === 'EXTERNAL'
                        ? {
                            kind, justification: 'external auditor, ISO engagement',
                            expiresAt: new Date(Date.now() + 90 * 86_400_000),
                        }
                        : { kind, justification: 'nobody in the team recognises this login' };

            await decideLegacyAccount(ctx(), {
                connectionId, accountKey: 'alovelace', executionId,
                action: action as never,
            });

            expect(await queue()).toEqual([]);
        }
    );

    it('a CONFIRMED account is out of the queue too', async () => {
        await decideLegacyAccount(ctx(), {
            connectionId, accountKey: 'alovelace', executionId,
            action: { kind: 'CONFIRM', employeeId },
        });
        expect(await queue()).toEqual([]);
    });

    it('an EXPIRED EXTERNAL comes BACK, labelled EXTERNAL_EXPIRED', async () => {
        const expiresAt = new Date(Date.now() + 86_400_000);
        await decideLegacyAccount(ctx(), {
            connectionId, accountKey: 'alovelace', executionId,
            action: { kind: 'EXTERNAL', justification: 'contractor through to year end', expiresAt },
        });
        // Before the date: suppressed.
        expect(await queue()).toEqual([]);

        // After it: back, and NOT as a fresh unknown. A lapsed contractor and an
        // unidentified login need different questions asked.
        const after = await queue(new Date(expiresAt.getTime() + 1000));
        expect(after).toHaveLength(1);
        expect(after[0].reason).toBe('EXTERNAL_EXPIRED');
        expect(after[0].expiredAt).toEqual(expiresAt);
    });

    it('a SUSPENDED alias does NOT suppress — that is the revalidation output', async () => {
        await decideLegacyAccount(ctx(), {
            connectionId, accountKey: 'alovelace', executionId,
            action: { kind: 'ORPHAN', justification: 'nobody recognises this login at all' },
        });
        expect(await queue()).toEqual([]);

        await prisma.legacyIdentityAlias.updateMany({
            where: { tenantId: T1, connectionId, accountKey: 'alovelace' },
            data: { status: 'SUSPENDED', suspendedReason: 'HR_RECORD_VANISHED', suspendedAt: new Date() },
        });

        // Suppressing on a suspended row would hide the revalidation pass's
        // output behind the pass's own effect.
        const q = await queue();
        expect(q).toHaveLength(1);
        expect(q[0].reason).toBe('UNDECIDED');
    });

    it('an alias on a DIFFERENT connection does not suppress', async () => {
        const other = await prisma.integrationConnection.create({
            data: { tenantId: T1, provider: 'legacy-mcp', name: 'second legacy', configJson: {} },
        });
        await decideLegacyAccount(ctx(), {
            connectionId: other.id, accountKey: 'alovelace', executionId,
            action: { kind: 'ORPHAN', justification: 'unattributable in the OTHER system' },
        });
        // The same login name in two legacy systems is two accounts, and one
        // decision says nothing about the other.
        const q = await queue();
        expect(q).toHaveLength(1);
        expect(q[0].reason).toBe('UNDECIDED');
    });

    it('listExpiredExternals reports the lapsed population for a connection', async () => {
        const expiresAt = new Date(Date.now() + 86_400_000);
        await decideLegacyAccount(ctx(), {
            connectionId, accountKey: 'alovelace', executionId,
            action: { kind: 'EXTERNAL', justification: 'contractor through to year end', expiresAt },
        });
        expect(await listExpiredExternals(ctx(), { connectionId })).toEqual([]);
        const lapsed = await listExpiredExternals(ctx(), {
            connectionId, now: new Date(expiresAt.getTime() + 1000),
        });
        expect(lapsed).toEqual([{ accountKey: 'alovelace', expiredAt: expiresAt }]);
    });

    it('a lapsed EXTERNAL is NOT recorded as a suspension', async () => {
        // `suspendedReason` is a closed set of four facts that make an alias
        // UNTRUSTWORTHY. "It got old" is not one of them, and writing it there
        // would make the suspension metric unreadable — a spike would mean a
        // quarter had ended rather than that something changed.
        const expiresAt = new Date(Date.now() + 1000);
        await decideLegacyAccount(ctx(), {
            connectionId, accountKey: 'alovelace', executionId,
            action: { kind: 'EXTERNAL', justification: 'short engagement, ends immediately', expiresAt },
        });
        const a = await prisma.legacyIdentityAlias.findFirstOrThrow({
            where: { tenantId: T1, connectionId, accountKey: 'alovelace' },
        });
        expect(a.status).toBe('ACTIVE');
        expect(a.suspendedReason).toBeNull();
    });
});

// ── Step 6c: the model's annotation, and the blind sample ───────────────────
//
// THE CENTRAL ASSERTION of this block is that a blind-sampled row is
// INDISTINGUISHABLE on the wire from a row the model said nothing about. If a
// reviewer could tell the two apart they would know which rows are being
// measured, and the precision the sample reports would describe a reviewer who
// knew they were being watched rather than a typical one.
describe('Step 6c — verdicts on the queue', () => {
    /** The first id at this index that the sampler does (or does not) withhold. */
    function idWhere(held: boolean): string {
        for (let i = 0; i < 500; i++) {
            const id = `vrd${String(i).padStart(12, '0')}`;
            if (isBlindHeld(id) === held) return id;
        }
        throw new Error(`no id found with blindHeld=${held} — the sampler is degenerate`);
    }

    async function seedVerdict(opts: {
        accountKey: string;
        verdictId: string;
        verdict: 'AGREES' | 'PROPOSES' | 'UNSURE' | null;
        reason?: 'NO_EVALUATION';
    }): Promise<void> {
        const resolution = await prisma.legacyAccountResolution.findFirstOrThrow({
            where: { tenantId: T1, accountKey: opts.accountKey },
            select: { id: true },
        });
        await prisma.legacyMatchVerdict.create({
            data: {
                id: opts.verdictId,
                tenantId: T1,
                resolutionId: resolution.id,
                modelId: 'laya',
                modelRevision: 'laya-multilingual',
                verdict: opts.verdict,
                nonVerdictReason: opts.reason ?? null,
                probabilitiesJson: opts.verdict ? { top: 'B' } : undefined,
                labellingJson: opts.verdict ? { A: 'emp-other', B: employeeId } : undefined,
                topProbability: opts.verdict ? 0.93 : null,
                topMargin: opts.verdict ? 0.4 : null,
            },
        });
    }

    // No `beforeEach` here: the suite's own already clears and RE-SEEDS, and a
    // second `clearOwnRows()` after it deletes the connection every fixture
    // below needs.

    it('shows a verdict with its probabilities AND its labelling', async () => {
        // One without the other is unreadable: the probabilities are keyed by
        // the shuffled letters that were sent, so `{"B": 0.93}` means nothing
        // until a letter resolves to a person.
        const exec = await seedResolution({
            accountKey: 'shown',
            outcome: 'SUGGESTED',
            candidates: [{ employeeId, score: 200 }],
        });
        await seedVerdict({ accountKey: 'shown', verdictId: idWhere(false), verdict: 'AGREES' });

        const queue = await listReconciliationQueue(ctx(), { executionId: exec, connectionId });
        const row = queue.find((q) => q.accountKey === 'shown');

        expect(row?.verdict).toMatchObject({
            verdict: 'AGREES',
            topOption: 'B',
            topProbability: 0.93,
            modelRevision: 'laya-multilingual',
        });
        // The letter resolves to the person, which is the whole point of
        // storing the labelling.
        expect(row?.verdict?.labelling.B).toBe(employeeId);
    });

    it('WITHHOLDS a blind-sampled verdict, identically to having none', async () => {
        const execHeld = await seedResolution({
            accountKey: 'blind',
            outcome: 'SUGGESTED',
            candidates: [{ employeeId, score: 200 }],
        });
        await seedVerdict({ accountKey: 'blind', verdictId: idWhere(true), verdict: 'AGREES' });

        const queue = await listReconciliationQueue(ctx(), {
            executionId: execHeld,
            connectionId,
        });
        const blind = queue.find((q) => q.accountKey === 'blind');

        expect(blind?.verdict).toBeNull();
    });

    it('is byte-identical to an unadjudicated row', async () => {
        // The positive control for the assertion above. Two accounts, same
        // shape, one carrying a withheld AGREES and one carrying no verdict at
        // all: serialise both rows and require them to differ ONLY in the
        // account key. Anything else is a tell.
        const exec = await seedResolution({
            accountKey: 'blind-2',
            outcome: 'SUGGESTED',
            candidates: [{ employeeId, score: 200 }],
        });
        await prisma.legacyAccountResolution.create({
            data: {
                tenantId: T1,
                executionId: exec,
                snapshotId,
                accountKey: 'plain-2',
                outcome: 'SUGGESTED',
                method: 'SUPPORTING_ONLY',
                employeeId: null,
                signalsJson: [{ kind: 'SIMILARITY', score: 120, evidence: '0.910' }],
                candidatesJson: [
                    { employeeId, score: 200, signals: [], vetoes: [], strongest: 'SUPPORTING' },
                ],
                vetoesJson: [],
            },
        });
        await seedVerdict({ accountKey: 'blind-2', verdictId: idWhere(true), verdict: 'AGREES' });

        const queue = await listReconciliationQueue(ctx(), { executionId: exec, connectionId });
        const blind = queue.find((q) => q.accountKey === 'blind-2');
        const plain = queue.find((q) => q.accountKey === 'plain-2');

        expect(blind).toBeDefined();
        expect(plain).toBeDefined();
        const normalise = (r: typeof blind) => JSON.stringify({ ...r, accountKey: 'X' });
        expect(normalise(blind)).toBe(normalise(plain));
    });

    it('withholds UNSURE too, so it is one less thing to tell apart', async () => {
        // A real verdict, and showing it would say "the model looked and had no
        // opinion" — information that does not help a reviewer decide, and one
        // more shape a blind row could be distinguished from. The design's
        // UNSURE lane is "the queue as it would be without a model".
        const exec = await seedResolution({
            accountKey: 'unsure',
            outcome: 'SUGGESTED',
            candidates: [{ employeeId, score: 200 }],
        });
        await seedVerdict({ accountKey: 'unsure', verdictId: idWhere(false), verdict: 'UNSURE' });

        const queue = await listReconciliationQueue(ctx(), { executionId: exec, connectionId });
        expect(queue.find((q) => q.accountKey === 'unsure')?.verdict).toBeNull();
    });

    it('shows nothing for a NON-VERDICT row', async () => {
        const exec = await seedResolution({
            accountKey: 'noeval',
            outcome: 'SUGGESTED',
            candidates: [{ employeeId, score: 200 }],
        });
        await seedVerdict({
            accountKey: 'noeval',
            verdictId: idWhere(false),
            verdict: null,
            reason: 'NO_EVALUATION',
        });

        const queue = await listReconciliationQueue(ctx(), { executionId: exec, connectionId });
        expect(queue.find((q) => q.accountKey === 'noeval')?.verdict).toBeNull();
    });

    it('shows the NEWEST revision when a row has two', async () => {
        // An older revision's answer has been superseded by a model somebody
        // deliberately changed to, so it must not be the one a reviewer reads.
        const exec = await seedResolution({
            accountKey: 'two-revs',
            outcome: 'SUGGESTED',
            candidates: [{ employeeId, score: 200 }],
        });
        const resolution = await prisma.legacyAccountResolution.findFirstOrThrow({
            where: { tenantId: T1, accountKey: 'two-revs' },
            select: { id: true },
        });
        const old = idWhere(false);
        await prisma.legacyMatchVerdict.create({
            data: {
                id: old,
                tenantId: T1,
                resolutionId: resolution.id,
                modelId: 'laya',
                modelRevision: 'laya-OLD',
                verdict: 'PROPOSES',
                probabilitiesJson: { top: 'A' },
                labellingJson: { A: employeeId },
                topProbability: 0.5,
                createdAt: new Date(Date.now() - 60_000),
            },
        });
        await prisma.legacyMatchVerdict.create({
            data: {
                id: `${old}-new`,
                tenantId: T1,
                resolutionId: resolution.id,
                modelId: 'laya',
                modelRevision: 'laya-NEW',
                verdict: 'AGREES',
                probabilitiesJson: { top: 'B' },
                labellingJson: { B: employeeId },
                topProbability: 0.97,
            },
        });

        const queue = await listReconciliationQueue(ctx(), { executionId: exec, connectionId });
        const row = queue.find((q) => q.accountKey === 'two-revs');
        // Only meaningful if the newest id is itself showable; `-new` is a
        // different digest, so assert what we actually got rather than assuming.
        if (row?.verdict) expect(row.verdict.modelRevision).toBe('laya-NEW');
        else expect(isBlindHeld(`${old}-new`)).toBe(true);
    });
});

// ── Step 6c: the AGREES bulk lane ───────────────────────────────────────────
//
// FIVE TERMS, AND THE MATRIX IS THE TEST. A single happy-path assertion is
// satisfied by `() => true`; what has to hold is that flipping each term on its
// own takes the row OUT of the lane. Bulk ratification is a person confirming
// many rows at once on the strength of a claim about the model, so every term
// is a reason somebody should have looked at that row individually.
describe('Step 6c — the AGREES bulk lane', () => {
    function idWhere(held: boolean): string {
        for (let i = 0; i < 500; i++) {
            const id = `bulk${String(i).padStart(12, '0')}`;
            if (isBlindHeld(id) === held) return id;
        }
        throw new Error(`no id found with blindHeld=${held}`);
    }

    /** A row set up to be eligible, with one term overridable. */
    async function eligibleRow(over: {
        accountKey?: string;
        employeeStatus?: 'ACTIVE' | 'TERMINATED';
        vetoes?: Record<string, string>[];
        isPrivileged?: boolean;
        suggestedRekeyed?: boolean | null;
        verdict?: 'AGREES' | 'PROPOSES';
        blind?: boolean;
        suggested?: boolean;
    } = {}): Promise<{ executionId: string; accountKey: string }> {
        const accountKey = over.accountKey ?? 'lane-1';
        const exec = await prisma.integrationExecution.create({
            data: {
                tenantId: T1, connectionId, status: 'PASSED',
                provider: 'legacy-mcp', automationKey: 'legacy-reconcile',
                executedAt: new Date(), completedAt: new Date(),
            },
        });
        if (over.employeeStatus === 'TERMINATED') {
            await prisma.employee.update({
                where: { id: employeeId },
                data: { status: 'TERMINATED' },
            });
        }
        await prisma.legacyAccount.create({
            data: {
                tenantId: T1, snapshotId, accountKey,
                username: 'i.ivanov', displayName: 'Ivanov, Ivan',
                status: 'ACTIVE', accountType: 'HUMAN',
                isPrivileged: over.isPrivileged ?? false,
                entitlements: [],
            },
        });
        const resolution = await prisma.legacyAccountResolution.create({
            data: {
                tenantId: T1, executionId: exec.id, snapshotId, accountKey,
                outcome: 'SUGGESTED', method: 'SUPPORTING_ONLY',
                employeeId: over.suggested === false ? null : employeeId,
                signalsJson: [],
                candidatesJson: [
                    { employeeId, score: 200, signals: [], vetoes: [], strongest: 'SUPPORTING' },
                ],
                vetoesJson: over.vetoes ?? [],
                suggestedRekeyed:
                    over.suggestedRekeyed === undefined ? false : over.suggestedRekeyed,
            },
            select: { id: true },
        });
        await prisma.legacyMatchVerdict.create({
            data: {
                id: idWhere(over.blind ?? false),
                tenantId: T1, resolutionId: resolution.id,
                modelId: 'laya', modelRevision: 'laya-multilingual',
                verdict: over.verdict ?? 'AGREES',
                probabilitiesJson: { top: 'A' },
                labellingJson: { A: employeeId },
                topProbability: 0.95, topMargin: 0.5,
            },
        });
        return { executionId: exec.id, accountKey };
    }

    async function eligibility(seeded: { executionId: string; accountKey: string }) {
        const queue = await listReconciliationQueue(ctx(), {
            executionId: seeded.executionId,
            connectionId,
        });
        return queue.find((q) => q.accountKey === seeded.accountKey);
    }

    it('admits a row that clears all five terms', async () => {
        const row = await eligibility(await eligibleRow());
        expect(row?.bulkEligible).toBe(true);
        // And the verdict IS shown for it, which is the other half of the lane:
        // a reviewer ratifying in bulk is told what they are agreeing with.
        expect(row?.verdict?.verdict).toBe('AGREES');
    });

    it.each([
        ['the candidate is TERMINATED', { employeeStatus: 'TERMINATED' as const }],
        ['the row has a veto', { vetoes: [{ kind: 'TEMPORAL', evidence: 'x' }] }],
        ['the account is PRIVILEGED', { isPrivileged: true }],
        ['the suggestion is a re-key successor', { suggestedRekeyed: true }],
        ['the verdict is PROPOSES, not AGREES', { verdict: 'PROPOSES' as const }],
        ['there is no engine suggestion to ratify', { suggested: false }],
    ])('refuses the lane when %s', async (_label, over) => {
        const row = await eligibility(await eligibleRow({ accountKey: 'lane-x', ...over }));
        expect(row?.bulkEligible).toBe(false);
    });

    it('refuses a row whose re-key term is UNKNOWN', async () => {
        // The column is nullable with no backfill, so a row written before it
        // existed genuinely does not know. Treating unknown as "not re-keyed"
        // would admit exactly those rows, and unknown is not a reason to
        // ratify in bulk.
        const row = await eligibility(
            await eligibleRow({ accountKey: 'lane-null', suggestedRekeyed: null }),
        );
        expect(row?.bulkEligible).toBe(false);
    });

    it('refuses a BLIND AGREES, and gives nothing away doing it', async () => {
        const blind = await eligibility(await eligibleRow({ accountKey: 'lane-blind', blind: true }));
        expect(blind?.bulkEligible).toBe(false);
        // The pair that must be indistinguishable: a withheld AGREES and a row
        // the model never answered both read {verdict: null, bulkEligible: false}.
        expect(blind?.verdict).toBeNull();
    });
});

// ── Step 6c: AI_PROPOSED_CONFIRMED ──────────────────────────────────────────
//
// The only way to measure, from stored rows, how often a reviewer takes the
// MODEL's alternative over the engine's suggestion. That number is the evidence
// that `PROPOSES` earns its place, so the four cases that must NOT claim it
// matter as much as the one that must.
describe('Step 6c — confirming the model\'s proposal', () => {
    function vid(held: boolean): string {
        for (let i = 0; i < 500; i++) {
            const id = `prop${String(i).padStart(12, '0')}`;
            if (isBlindHeld(id) === held) return id;
        }
        throw new Error('sampler degenerate');
    }

    async function seed(opts: {
        accountKey: string;
        verdict: 'PROPOSES' | 'AGREES' | null;
        /** Which employee the model's top letter maps to. */
        picked?: string;
        blind?: boolean;
    }): Promise<string> {
        const exec = await seedResolution({
            accountKey: opts.accountKey,
            outcome: 'SUGGESTED',
            candidates: [{ employeeId, score: 200 }],
        });
        if (opts.verdict) {
            const resolution = await prisma.legacyAccountResolution.findFirstOrThrow({
                where: { tenantId: T1, accountKey: opts.accountKey },
                select: { id: true },
            });
            await prisma.legacyMatchVerdict.create({
                data: {
                    id: vid(opts.blind ?? false),
                    tenantId: T1,
                    resolutionId: resolution.id,
                    modelId: 'laya',
                    modelRevision: 'laya-multilingual',
                    verdict: opts.verdict,
                    probabilitiesJson: { top: 'A' },
                    labellingJson: { A: opts.picked ?? employeeId },
                    topProbability: 0.95,
                },
            });
        }
        return exec;
    }

    async function methodAfterConfirm(accountKey: string, exec: string): Promise<string> {
        await decideLegacyAccount(ctx(), {
            connectionId,
            executionId: exec,
            accountKey,
            action: { kind: 'CONFIRM', employeeId },
        });
        const alias = await prisma.legacyIdentityAlias.findFirstOrThrow({
            where: { tenantId: T1, connectionId, accountKey },
            select: { method: true },
        });
        return alias.method;
    }

    it('records AI_PROPOSED_CONFIRMED when the reviewer takes the model pick', async () => {
        const exec = await seed({ accountKey: 'prop-yes', verdict: 'PROPOSES' });
        expect(await methodAfterConfirm('prop-yes', exec)).toBe('AI_PROPOSED_CONFIRMED');
    });

    it('keeps CONFIRMED_ALIAS when the model proposed somebody ELSE', async () => {
        // The reviewer rejected the proposal and picked for themselves. That is
        // the fact worth storing, and crediting the model here would make the
        // metric unreadable in the direction that flatters it.
        const exec = await seed({
            accountKey: 'prop-other',
            verdict: 'PROPOSES',
            picked: otherTenantEmployeeId,
        });
        expect(await methodAfterConfirm('prop-other', exec)).toBe('CONFIRMED_ALIAS');
    });

    it('keeps CONFIRMED_ALIAS for an AGREES verdict', async () => {
        // AGREES names the ENGINE's own suggestion, so the engine's method is
        // still the truthful account of how the link was found. Agreement is
        // not independence — both lean on names — so letting an AGREES claim
        // the method would credit the model for the engine's work.
        const exec = await seed({ accountKey: 'prop-agrees', verdict: 'AGREES' });
        expect(await methodAfterConfirm('prop-agrees', exec)).toBe('CONFIRMED_ALIAS');
    });

    it('keeps CONFIRMED_ALIAS when there is no verdict at all', async () => {
        const exec = await seed({ accountKey: 'prop-none', verdict: null });
        expect(await methodAfterConfirm('prop-none', exec)).toBe('CONFIRMED_ALIAS');
    });

    it('stores the verdict REFERENCE even for a blind row', async () => {
        // THE ASYMMETRY, and the reason both halves of this exist. The method
        // must not credit the model for a pick the reviewer could not see; the
        // reference is what makes the blind comparison possible at all.
        // Withholding it would remove the measurement the sample exists to take.
        const exec = await seed({ accountKey: 'ref-blind', verdict: 'PROPOSES', blind: true });
        await methodAfterConfirm('ref-blind', exec);

        const alias = await prisma.legacyIdentityAlias.findFirstOrThrow({
            where: { tenantId: T1, connectionId, accountKey: 'ref-blind' },
            select: { method: true, verdictId: true },
        });
        expect(alias.method).toBe('CONFIRMED_ALIAS');
        expect(alias.verdictId).not.toBeNull();
    });

    it('stores the reference for an AGREES ratification', async () => {
        const exec = await seed({ accountKey: 'ref-agrees', verdict: 'AGREES' });
        await methodAfterConfirm('ref-agrees', exec);

        const alias = await prisma.legacyIdentityAlias.findFirstOrThrow({
            where: { tenantId: T1, connectionId, accountKey: 'ref-agrees' },
            select: { method: true, verdictId: true },
        });
        // The engine's method, AND the model's verdict beside it — which is
        // exactly what the checklist line asks for.
        expect(alias.method).toBe('CONFIRMED_ALIAS');
        expect(alias.verdictId).not.toBeNull();
    });

    it('leaves the reference NULL when no verdict exists', async () => {
        const exec = await seed({ accountKey: 'ref-none', verdict: null });
        await methodAfterConfirm('ref-none', exec);

        const alias = await prisma.legacyIdentityAlias.findFirstOrThrow({
            where: { tenantId: T1, connectionId, accountKey: 'ref-none' },
            select: { verdictId: true },
        });
        // Not an empty string, and not a sentinel: every alias confirmed before
        // adjudication existed genuinely has no verdict.
        expect(alias.verdictId).toBeNull();
    });

    it('keeps CONFIRMED_ALIAS for a BLIND-sampled proposal', async () => {
        // The subtle one, and the reason the blind sample works at all: the
        // reviewer was never shown this verdict, so their decision is the
        // independent measurement. Crediting the model for a pick nobody could
        // see would corrupt the one number that says whether it is right on
        // this tenant's data — and it would do so silently, because the row
        // looks exactly like a reviewer agreeing.
        const exec = await seed({ accountKey: 'prop-blind', verdict: 'PROPOSES', blind: true });
        expect(await methodAfterConfirm('prop-blind', exec)).toBe('CONFIRMED_ALIAS');
    });
});
