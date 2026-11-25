/**
 * `scripts/dsar-erase.ts` (#5802, #5940) — what the operator command refuses,
 * and what it prints, over fake dependencies whose DECISION is the real one
 * (`decideErasureRequest`, with a fake membership read). The DB-backed run of
 * the whole flow is `tests/integration/dsar-erase-command.test.ts`.
 */
import type { ErasurePlan, ErasureReceipt, ErasureReference } from '@/app-layer/jobs/dsar-erasure';
import { erasureWorkspacesFrom } from '@/app-layer/jobs/dsar-erasure-workspaces';
import { decideErasureRequest, type ErasureRequestRow } from '@/app-layer/jobs/dsar-erasure-request';
import {
    EXIT_OK,
    EXIT_REFUSED,
    EXIT_USAGE,
    failureLine,
    runDsarErase,
    type DsarEraseDeps,
} from '../../scripts/dsar-erase';

const SUBJECT = 'cksubject0000000000000001';
const REQUEST = 'ckrequest0000000000000001';
const ADDRESS = 'someone@example.test';
const NOW = new Date('2026-11-25T12:00:00.000Z');
const HOUR = 3_600_000;

function request(overrides: Partial<ErasureRequestRow> = {}): ErasureRequestRow {
    return {
        id: REQUEST,
        userId: SUBJECT,
        type: 'ERASURE',
        status: 'IN_PROGRESS',
        verifiedAt: new Date(NOW.getTime() - 25 * HOUR),
        completedAt: null,
        ...overrides,
    };
}

function erasurePlan(blockers: ErasureReference[] = []): ErasurePlan {
    return { userId: SUBJECT, auditRowsToPseudonymize: 3, references: blockers, blockers, wouldSucceed: blockers.length === 0, writes: 0 };
}

const receipt: ErasureReceipt = {
    userId: SUBJECT,
    auditRowsPseudonymized: 3,
    auditRowsDeleted: 0,
    userDeleted: true,
    erasureRecordIds: ['rec-1'],
    auditRowsTolerated: 3,
    requestCompleted: REQUEST,
    registerRequestsCleared: 1,
};

function deps(
    options: {
        row?: ErasureRequestRow | null;
        due?: ErasureRequestRow[];
        soleOwnerTenants?: number;
        blockers?: ErasureReference[];
        unlistedAction?: boolean;
    } = {},
) {
    const lines: string[] = [];
    const workspaces = erasureWorkspacesFrom(SUBJECT, {
        audit: [
            { tenantId: 't-acted', userId: SUBJECT, entity: 'Risk', entityId: null, action: 'RISK_CREATED', rows: 2 },
            { tenantId: 't-removed', userId: 'admin-1', entity: 'TenantMembership', entityId: 'm-1', action: 'MEMBER_REMOVED', targetUserId: SUBJECT },
            ...(options.unlistedAction
                ? [{ tenantId: 't-new', userId: null, entity: 'TenantMembership', entityId: SUBJECT, action: 'NEW_MEMBERSHIP_GRANT' }]
                : []),
        ],
        orgFanout: [],
    });
    const membershipDb = {
        $queryRawUnsafe: async <T,>() => [{ n: options.soleOwnerTenants ?? 0 }] as unknown as T,
    };
    const d = {
        now: () => NOW,
        readRequest: jest.fn(async (id: string) => ('row' in options ? options.row ?? null : request({ id }))),
        readDue: jest.fn(async () => options.due ?? [request()]),
        decide: jest.fn((row: ErasureRequestRow, now: Date) => decideErasureRequest(membershipDb, row, now)),
        plan: jest.fn(async () => ({ erasure: erasurePlan(options.blockers), workspaces })),
        erase: jest.fn<ReturnType<DsarEraseDeps['erase']>, Parameters<DsarEraseDeps['erase']>>(async (_userId, _request, afterCommit) => {
            await afterCommit(workspaces.tenantIds);
            return receipt;
        }),
        cleanUp: jest.fn(async (tenantIds: readonly string[]) =>
            tenantIds.map((tenantId) => ({ tenantId, connectionId: `conn-${tenantId}`, status: 'DONE', reason: null })),
        ),
        log: (line: string) => lines.push(line),
    } satisfies DsarEraseDeps;
    return { d, out: () => lines.join('\n'), lines };
}

describe('dsar-erase — the plan writes nothing; --confirm erases the request\'s subject', () => {
    it('reads the subject from the request and prints the plan — workspaces, evidence, what it cannot see, the operator checks', async () => {
        const { d, out } = deps();
        expect(await runDsarErase(['--request', REQUEST], d)).toBe(EXIT_OK);
        expect(d.plan).toHaveBeenCalledWith(SUBJECT);
        expect(d.erase).not.toHaveBeenCalled();
        expect(d.cleanUp).not.toHaveBeenCalled();
        expect(out()).toContain(`request ${REQUEST} type=ERASURE status=IN_PROGRESS`);
        expect(out()).toContain(`subject=${SUBJECT}`);
        expect(out()).toContain('workspaces where the subject held a membership: 2');
        expect(out()).toContain('t-removed evidence=TARGET_RECORD rows=1');
        expect(out()).toContain('t-acted evidence=OWN_ACTION rows=2');
        expect(out()).toContain('tenant-purge.ts');
        expect(out()).toContain('outstanding balance: the product holds no balance for a person');
        expect(out()).toContain('legal hold: the product holds no hold for a person');
        expect(out()).toContain('plan only: nothing written');
    });

    it('with --confirm it erases with the request, then hands the clean-up exactly the planned workspaces', async () => {
        const { d, out } = deps();
        expect(await runDsarErase(['--request', REQUEST, '--confirm'], d)).toBe(EXIT_OK);
        expect(d.erase).toHaveBeenCalledTimes(1);
        expect(d.erase.mock.calls[0][0]).toBe(SUBJECT);
        expect(d.erase.mock.calls[0][1]).toEqual({ id: REQUEST, now: NOW });
        expect(d.cleanUp).toHaveBeenCalledWith(['t-acted', 't-removed']);
        expect(out()).toContain(`register: request completed=${REQUEST} requests cleared=1`);
        expect(out()).toContain('t-removed conn-t-removed DONE');
    });

    it('--due acts on the one due request', async () => {
        const { d, out } = deps({ due: [request({ id: 'ckdue00000000000000000001' })] });
        expect(await runDsarErase(['--due', '--confirm'], d)).toBe(EXIT_OK);
        expect(d.readRequest).not.toHaveBeenCalled();
        expect(d.erase.mock.calls[0][1]).toEqual({ id: 'ckdue00000000000000000001', now: NOW });
        expect(out()).toContain('request ckdue00000000000000000001');
    });

    it('prints only lines carrying its prefix, so the public-log filter keeps every one', async () => {
        const { d, lines } = deps();
        await runDsarErase(['--request', REQUEST, '--confirm'], d);
        expect(lines.length).toBeGreaterThan(10);
        expect(lines.filter((l) => !l.startsWith('[dsar-erase] '))).toEqual([]);
    });
});

describe('dsar-erase — the request decides, each refusal by its name', () => {
    it.each<[string, Partial<ErasureRequestRow>, string]>([
        ['an export request', { type: 'EXPORT' }, 'NOT_AN_ERASURE'],
        ['a completed request', { status: 'COMPLETED', completedAt: new Date(NOW.getTime() - HOUR) }, 'ALREADY_COMPLETED'],
        ['a rejected request', { status: 'REJECTED' }, 'REQUEST_REJECTED'],
        ['a cancelled request', { status: 'CANCELED' }, 'REQUEST_CANCELED'],
        ['a request never verified', { status: 'RECEIVED', verifiedAt: null }, 'NOT_VERIFIED'],
        ['a request verified 23 hours ago', { verifiedAt: new Date(NOW.getTime() - 23 * HOUR) }, 'COOLING_OFF'],
        ['a verified request nobody started', { status: 'VERIFIED' }, 'NOT_IN_PROGRESS'],
        ['a request whose subject is already erased', { userId: null }, 'SUBJECT_ALREADY_ERASED'],
    ])('refuses %s (%s), and neither plans nor erases', async (_label, overrides, reason) => {
        const { d, out } = deps({ row: request(overrides) });
        expect(await runDsarErase(['--request', REQUEST, '--confirm'], d)).toBe(EXIT_REFUSED);
        expect(out()).toContain(`refused: ${reason}.`);
        expect(d.plan).not.toHaveBeenCalled();
        expect(d.erase).not.toHaveBeenCalled();
    });

    it('refuses a request that does not exist', async () => {
        const { d, out } = deps({ row: null });
        expect(await runDsarErase(['--request', REQUEST], d)).toBe(EXIT_REFUSED);
        expect(out()).toContain('REQUEST_NOT_FOUND');
        expect(d.decide).not.toHaveBeenCalled();
    });

    it('applies evaluateDsarRejection: the sole OWNER of a workspace is LAST_OWNER', async () => {
        const { d, out } = deps({ soleOwnerTenants: 1 });
        expect(await runDsarErase(['--request', REQUEST, '--confirm'], d)).toBe(EXIT_REFUSED);
        expect(out()).toContain('refused: REJECTION_CRITERION (last_owner)');
        expect(d.erase).not.toHaveBeenCalled();
    });

    it('a request cooled off by exactly 24 hours is admitted', async () => {
        const { d } = deps({ row: request({ verifiedAt: new Date(NOW.getTime() - 24 * HOUR) }) });
        expect(await runDsarErase(['--request', REQUEST], d)).toBe(EXIT_OK);
    });

    it('--due refuses when none is due, and when more than one is', async () => {
        const none = deps({ due: [] });
        expect(await runDsarErase(['--due'], none.d)).toBe(EXIT_REFUSED);
        expect(none.out()).toContain('refused: NO_DUE_REQUEST');
        const two = deps({ due: [request({ id: 'ckone' }), request({ id: 'cktwo' })] });
        expect(await runDsarErase(['--due', '--confirm'], two.d)).toBe(EXIT_REFUSED);
        expect(two.out()).toContain('refused: MORE_THAN_ONE_DUE');
        expect(two.d.plan).not.toHaveBeenCalled();
        expect(two.d.erase).not.toHaveBeenCalled();
    });

    it('refuses a tenant system user as the subject', async () => {
        const { d, out } = deps({ row: request({ userId: 'sys_tenant-1' }) });
        expect(await runDsarErase(['--request', REQUEST, '--confirm'], d)).toBe(EXIT_REFUSED);
        expect(out()).toContain('SYSTEM_USER');
        expect(d.plan).not.toHaveBeenCalled();
    });
});

describe('dsar-erase — the plan refuses what the erasure would', () => {
    it('exits non-zero, plan only, while a reference blocks the delete, so a preflight fails before the write', async () => {
        const membership: ErasureReference = {
            table: 'TenantMembership', column: 'userId', onDelete: 'RESTRICT', rows: 1, effect: 'BLOCKS_DELETE', reason: 'RESTRICT_REFERENCE',
        };
        const { d, out } = deps({ blockers: [membership] });
        expect(await runDsarErase(['--request', REQUEST], d)).toBe(EXIT_REFUSED);
        expect(await runDsarErase(['--request', REQUEST, '--confirm'], d)).toBe(EXIT_REFUSED);
        expect(d.erase).not.toHaveBeenCalled();
        expect(out()).toContain('TenantMembership.userId rows=1 RESTRICT_REFERENCE');
        expect(out()).toContain('Nothing written');
    });

    it('refuses while a membership record names the subject under an action it does not classify', async () => {
        const { d, out } = deps({ unlistedAction: true });
        expect(await runDsarErase(['--request', REQUEST, '--confirm'], d)).toBe(EXIT_REFUSED);
        expect(d.erase).not.toHaveBeenCalled();
        expect(out()).toContain('AuditLog t-new NEW_MEMBERSHIP_GRANT UNLISTED_MEMBERSHIP_ACTION');
    });
});

describe('dsar-erase — usage refusals', () => {
    it.each([
        ['an e-mail as --request', ['--request', ADDRESS, '--confirm']],
        ['an e-mail as --request=', [`--request=${ADDRESS}`]],
        ['an e-mail as a bare argument', [ADDRESS, '--confirm']],
        ['an unknown flag carrying it', [`--email=${ADDRESS}`]],
        ['the retired --user flag carrying it', ['--user', ADDRESS]],
    ])('refuses %s without echoing it, and reads nothing', async (_label, args) => {
        const { d, out } = deps();
        expect(await runDsarErase(args, d)).toBe(EXIT_USAGE);
        expect(d.readRequest).not.toHaveBeenCalled();
        expect(d.readDue).not.toHaveBeenCalled();
        expect(out()).not.toContain(ADDRESS);
        expect(out()).not.toContain('someone');
    });

    it('refuses a missing target, an empty --request, and both targets at once', async () => {
        const { d } = deps();
        expect(await runDsarErase(['--confirm'], d)).toBe(EXIT_USAGE);
        expect(await runDsarErase(['--request'], d)).toBe(EXIT_USAGE);
        expect(await runDsarErase(['--request', REQUEST, '--due'], d)).toBe(EXIT_USAGE);
        expect(d.readRequest).not.toHaveBeenCalled();
        expect(d.readDue).not.toHaveBeenCalled();
    });
});

describe('dsar-erase — a failure line is safe for a public log', () => {
    it('prints its own errors whole, and withholds the message of anything else', () => {
        const own = Object.assign(new Error('dsar-erasure: request "ckx" refused: COOLING_OFF. Nothing was written.'), {
            name: 'ErasureRequestRefusedError',
        });
        expect(failureLine(own)).toContain('COOLING_OFF');
        const driver = Object.assign(new Error('connect to postgres://u:sekret@db failed'), { code: 'P1001' });
        expect(failureLine(driver)).not.toContain('sekret');
        expect(failureLine(driver)).toContain('P1001');
        expect(failureLine(driver).startsWith('[dsar-erase] ')).toBe(true);
    });
});
