/**
 * `scripts/dsar-erase-user.ts` (#5802) — what the operator command refuses,
 * and what it prints, over fake dependencies. The DB-backed run of the whole
 * flow is `tests/integration/dsar-erase-user-command.test.ts`.
 */
import type { ErasurePlan, ErasureReceipt, ErasureReference } from '@/app-layer/jobs/dsar-erasure';
import { erasureWorkspacesFrom } from '@/app-layer/jobs/dsar-erasure-workspaces';
import {
    EXIT_OK,
    EXIT_REFUSED,
    EXIT_USAGE,
    runDsarEraseUser,
    type DsarEraseUserDeps,
} from '../../scripts/dsar-erase-user';

const SUBJECT = 'cksubject0000000000000001';
const ADDRESS = 'someone@example.test';

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
};

function deps(options: { blockers?: ErasureReference[]; unlistedAction?: boolean } = {}) {
    const lines: string[] = [];
    const workspaces = erasureWorkspacesFrom(SUBJECT, {
        audit: [
            { tenantId: 't-acted', userId: SUBJECT, entity: 'Risk', entityId: null, action: 'RISK_CREATED', rows: 2 },
            { tenantId: 't-scim', userId: null, entity: 'TenantMembership', entityId: SUBJECT, action: 'SCIM_USER_CREATED' },
            ...(options.unlistedAction
                ? [{ tenantId: 't-new', userId: null, entity: 'TenantMembership', entityId: SUBJECT, action: 'NEW_MEMBERSHIP_GRANT' }]
                : []),
        ],
        orgFanout: [],
    });
    const d = {
        plan: jest.fn(async () => ({ erasure: erasurePlan(options.blockers), workspaces })),
        erase: jest.fn<ReturnType<DsarEraseUserDeps['erase']>, Parameters<DsarEraseUserDeps['erase']>>(async (_userId, afterCommit) => {
            await afterCommit(workspaces.tenantIds);
            return receipt;
        }),
        cleanUp: jest.fn(async (tenantIds: readonly string[]) =>
            tenantIds.map((tenantId) => ({ tenantId, connectionId: `conn-${tenantId}`, status: 'DONE', reason: null })),
        ),
        log: (line: string) => lines.push(line),
    } satisfies DsarEraseUserDeps;
    return { d, out: () => lines.join('\n') };
}

describe('dsar-erase-user — without --confirm it writes nothing', () => {
    it('prints the plan — every workspace, its evidence, the writers it cannot see — and never erases', async () => {
        const { d, out } = deps();
        expect(await runDsarEraseUser(['--user', SUBJECT], d)).toBe(EXIT_OK);
        expect(d.erase).not.toHaveBeenCalled();
        expect(d.cleanUp).not.toHaveBeenCalled();
        expect(out()).toContain('workspaces where the subject held a membership: 2');
        expect(out()).toContain('t-scim evidence=MEMBERSHIP_RECORD rows=1');
        expect(out()).toContain('t-acted evidence=OWN_ACTION rows=2');
        expect(out()).toContain('src/app-layer/usecases/sso.ts');
        expect(out()).toContain('24h cooling-off');
        expect(out()).toContain('dry run: nothing written');
    });

    it('with --confirm it erases, then hands the clean-up exactly the planned workspaces', async () => {
        const { d, out } = deps();
        expect(await runDsarEraseUser(['--user', SUBJECT, '--confirm'], d)).toBe(EXIT_OK);
        expect(d.erase).toHaveBeenCalledTimes(1);
        expect(d.cleanUp).toHaveBeenCalledWith(['t-acted', 't-scim']);
        expect(out()).toContain('workspaces handed to the Managed Agents clean-up: 2');
        expect(out()).toContain('t-scim conn-t-scim DONE');
    });
});

describe('dsar-erase-user — refusals', () => {
    it('refuses a tenant system user (sys_) before reading anything', async () => {
        const { d, out } = deps();
        expect(await runDsarEraseUser(['--user', 'sys_tenant-1', '--confirm'], d)).toBe(EXIT_USAGE);
        expect(d.plan).not.toHaveBeenCalled();
        expect(d.erase).not.toHaveBeenCalled();
        expect(out()).toContain('system user');
    });

    it.each([
        ['an e-mail as --user', ['--user', ADDRESS, '--confirm']],
        ['an e-mail as --user=', [`--user=${ADDRESS}`]],
        ['an e-mail as a bare argument', [ADDRESS, '--confirm']],
        ['an unknown flag carrying it', [`--email=${ADDRESS}`]],
    ])('refuses %s without echoing it, and reads nothing', async (_label, args) => {
        const { d, out } = deps();
        expect(await runDsarEraseUser(args, d)).toBe(EXIT_USAGE);
        expect(d.plan).not.toHaveBeenCalled();
        expect(out()).not.toContain(ADDRESS);
        expect(out()).not.toContain('someone');
    });

    it('refuses a missing --user', async () => {
        const { d } = deps();
        expect(await runDsarEraseUser(['--confirm'], d)).toBe(EXIT_USAGE);
        expect(await runDsarEraseUser(['--user'], d)).toBe(EXIT_USAGE);
        expect(d.plan).not.toHaveBeenCalled();
    });

    it('refuses --confirm while a reference blocks the delete, a membership included, as eraseUser would', async () => {
        const membership: ErasureReference = {
            table: 'TenantMembership', column: 'userId', onDelete: 'RESTRICT', rows: 1, effect: 'BLOCKS_DELETE', reason: 'RESTRICT_REFERENCE',
        };
        const { d, out } = deps({ blockers: [membership] });
        expect(await runDsarEraseUser(['--user', SUBJECT, '--confirm'], d)).toBe(EXIT_REFUSED);
        expect(d.erase).not.toHaveBeenCalled();
        expect(out()).toContain('TenantMembership.userId rows=1 RESTRICT_REFERENCE');
        expect(out()).toContain('Nothing written');
    });

    it('refuses --confirm while a membership record names the subject under an action it does not classify', async () => {
        const { d, out } = deps({ unlistedAction: true });
        expect(await runDsarEraseUser(['--user', SUBJECT, '--confirm'], d)).toBe(EXIT_REFUSED);
        expect(d.erase).not.toHaveBeenCalled();
        expect(out()).toContain('AuditLog t-new NEW_MEMBERSHIP_GRANT UNLISTED_MEMBERSHIP_ACTION');
    });
});
