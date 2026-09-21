/**
 * #2714 — the create verb.
 *
 * Each PARTIAL state is reachable here, because each names an account left in
 * a DIFFERENT real-world condition (#2674 acceptance 2). A test that only
 * proved the happy path would prove the least interesting thing this module
 * does: a create's value is in how it fails.
 */
import {
    createDirectoryAccount,
    type CreateAccountRequest,
} from '@/app-layer/usecases/identity-create-account';
import type {
    DirectoryProvisioner,
    CreateAccountStep,
    ProvisionStep,
} from '@/app-layer/integrations/identity-provisioner';

const settled: string[] = [];
const handle = () => ({
    journalId: 'j-1',
    applied: jest.fn(async () => { settled.push('applied'); }),
    failed: jest.fn(async (d: string) => { settled.push(`failed:${d.slice(0, 12)}`); }),
    reverted: jest.fn(async () => { settled.push('reverted'); }),
    indeterminate: jest.fn(async () => { settled.push('indeterminate'); }),
});

const begun: string[] = [];
jest.mock('@/app-layer/usecases/identity-write-journal', () => ({
    beginWrite: jest.fn(async (_ctx: unknown, input: { action: string }) => {
        begun.push(input.action);
        return {
            journalId: 'j-1',
            applied: jest.fn(async () => {}),
            failed: jest.fn(async () => {}),
            reverted: jest.fn(async () => {}),
            indeterminate: jest.fn(async () => {}),
        };
    }),
}));

const CTX = { tenantId: 't-1', userId: 'u-1' } as never;
const OK: ProvisionStep = { kind: 'applied' };

function provisioner(over: Partial<DirectoryProvisioner> = {}): DirectoryProvisioner {
    return {
        provider: 'entra-id',
        collisionNamespaces: ['userPrincipalName', 'mailNickname'],
        probeIdentifier: jest.fn(async () => ({ kind: 'free', namespacesChecked: [] })) as never,
        createBlockedAccount: jest.fn(
            async (): Promise<CreateAccountStep> => ({ kind: 'applied', externalUserId: 'ext-1' }),
        ),
        assignGroup: jest.fn(async (): Promise<ProvisionStep> => OK),
        issueCredential: jest.fn(async (): Promise<ProvisionStep> => OK),
        enableAccount: jest.fn(async (): Promise<ProvisionStep> => OK),
        ...over,
    };
}

function req(over: Partial<CreateAccountRequest> = {}): CreateAccountRequest {
    return {
        provisioner: provisioner(),
        candidate: { identifier: 'jane.smith@acme.com', displayName: 'Jane Smith', employeeId: 'emp-1' },
        groupId: 'grp-eng',
        mode: 'AUTOMATIC',
        disableCreated: jest.fn(async () => {}),
        ...over,
    };
}

beforeEach(() => {
    settled.length = 0;
    begun.length = 0;
    jest.clearAllMocks();
});

describe('the sequence is owner decision 3 — group BEFORE credential', () => {
    it('assigns the group before minting the credential', async () => {
        const order: string[] = [];
        const p = provisioner({
            createBlockedAccount: jest.fn(async () => {
                order.push('create');
                return { kind: 'applied', externalUserId: 'ext-1' } as CreateAccountStep;
            }),
            assignGroup: jest.fn(async () => { order.push('group'); return OK; }),
            issueCredential: jest.fn(async () => { order.push('credential'); return OK; }),
            enableAccount: jest.fn(async () => { order.push('enable'); return OK; }),
        });

        await createDirectoryAccount(CTX, req({ provisioner: p, writeBackToHris: async () => {} }));

        // The design sketched create → credential → group. Decision 3 governs,
        // and this is the assertion that keeps the code on the decision's side.
        expect(order).toEqual(['create', 'group', 'credential', 'enable']);
        expect(order.indexOf('group')).toBeLessThan(order.indexOf('credential'));
    });

    it('creates the account SIGN-IN BLOCKED and enables it last', async () => {
        const p = provisioner();
        await createDirectoryAccount(CTX, req({ provisioner: p, writeBackToHris: async () => {} }));
        // There is no "create enabled" verb to call by accident.
        expect(p.createBlockedAccount).toHaveBeenCalledTimes(1);
        expect(p.enableAccount).toHaveBeenCalledTimes(1);
    });
});

describe('every partial-failure terminal state is reachable (#2674 acceptance 2)', () => {
    it('PARTIAL_NO_GROUP — account exists, blocked, unentitled; rolled back', async () => {
        const disableCreated = jest.fn(async () => {});
        const r = await createDirectoryAccount(CTX, req({
            provisioner: provisioner({
                assignGroup: jest.fn(async (): Promise<ProvisionStep> => ({ kind: 'refused', detail: 'group not found' })),
            }),
            disableCreated,
        }));

        expect(r.kind).toBe('PARTIAL_NO_GROUP');
        if (r.kind !== 'PARTIAL_NO_GROUP') throw new Error('narrowing');
        expect(r.externalUserId).toBe('ext-1');
        expect(r.rolledBack).toBe(true);
        // Decision 4: rollback is DISABLE, never delete.
        expect(disableCreated).toHaveBeenCalledWith('ext-1');
    });

    it('PARTIAL_NO_CREDENTIAL — account exists and is entitled, cannot sign in', async () => {
        const r = await createDirectoryAccount(CTX, req({
            provisioner: provisioner({
                issueCredential: jest.fn(async (): Promise<ProvisionStep> => ({
                    kind: 'refused',
                    detail: 'TAP policy disabled',
                })),
            }),
        }));

        expect(r.kind).toBe('PARTIAL_NO_CREDENTIAL');
        if (r.kind !== 'PARTIAL_NO_CREDENTIAL') throw new Error('narrowing');
        // Never a password fallback — the refusal is carried, not worked around.
        expect(r.detail).toContain('TAP policy disabled');
        expect(r.rolledBack).toBe(true);
    });

    it('PARTIAL_NO_HRIS_WRITEBACK — usable account, system of record unaware; NOT rolled back', async () => {
        const disableCreated = jest.fn(async () => {});
        const r = await createDirectoryAccount(CTX, req({ disableCreated }));

        expect(r.kind).toBe('PARTIAL_NO_HRIS_WRITEBACK');
        // The least severe of the three and the only safely retryable one.
        // Disabling a working account because a downstream write failed would
        // turn a bookkeeping gap into an outage for a real person.
        expect(disableCreated).not.toHaveBeenCalled();
    });

    it('REFUSED — nothing created, so nothing to roll back', async () => {
        const disableCreated = jest.fn(async () => {});
        const r = await createDirectoryAccount(CTX, req({
            provisioner: provisioner({
                createBlockedAccount: jest.fn(async (): Promise<CreateAccountStep> => ({
                    kind: 'refused',
                    detail: 'no write path',
                })),
            }),
            disableCreated,
        }));

        expect(r.kind).toBe('REFUSED');
        expect(disableCreated).not.toHaveBeenCalled();
    });

    it('INDETERMINATE does NOT roll back — we may be disabling something we never made', async () => {
        const disableCreated = jest.fn(async () => {});
        const r = await createDirectoryAccount(CTX, req({
            provisioner: provisioner({
                createBlockedAccount: jest.fn(async (): Promise<CreateAccountStep> => ({
                    kind: 'indeterminate',
                    detail: 'timeout',
                })),
            }),
            disableCreated,
        }));

        expect(r.kind).toBe('INDETERMINATE');
        expect(disableCreated).not.toHaveBeenCalled();
    });

    it('a failed rollback is reported, not swallowed', async () => {
        const r = await createDirectoryAccount(CTX, req({
            provisioner: provisioner({
                assignGroup: jest.fn(async (): Promise<ProvisionStep> => ({ kind: 'refused', detail: 'nope' })),
            }),
            disableCreated: jest.fn(async () => { throw new Error('directory down'); }),
        }));

        expect(r.kind).toBe('PARTIAL_NO_GROUP');
        if (r.kind !== 'PARTIAL_NO_GROUP') throw new Error('narrowing');
        expect(r.rolledBack).toBe(false);
    });
});

describe('every write is journalled BEFORE it is attempted', () => {
    it('opens CREATE_ACCOUNT and ASSIGN_GROUP rows — the two verbs nothing constructed before', async () => {
        await createDirectoryAccount(CTX, req({ writeBackToHris: async () => {} }));
        expect(begun).toEqual(['CREATE_ACCOUNT', 'ASSIGN_GROUP']);
    });

    it('journals the create even when the create is REFUSED', async () => {
        await createDirectoryAccount(CTX, req({
            provisioner: provisioner({
                createBlockedAccount: jest.fn(async (): Promise<CreateAccountStep> => ({ kind: 'refused', detail: 'x' })),
            }),
        }));
        // The row exists because `beginWrite` ran first. A journal written
        // only on success cannot answer "what did we try".
        expect(begun).toEqual(['CREATE_ACCOUNT']);
    });
});

describe('the snapshot provisioner cannot write — what makes DRY_RUN honest (#2714)', () => {
    // `createSnapshotProvisioner` is what every mode BELOW AUTOMATIC resolves
    // to. If any of its four mutating verbs returned `applied`, a dry run and a
    // real run would be indistinguishable in the journal. These assertions are
    // the reason raising JOINER_MAX_MODE is not merely a constant change.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createSnapshotProvisioner } = require('@/app-layer/integrations/identity-provisioner');

    it('refuses all four mutating verbs, and refuses rather than going indeterminate', async () => {
        const p = createSnapshotProvisioner('entra-id', ['userPrincipalName']);
        const steps = [
            await p.createBlockedAccount({ identifier: 'a@b.c', displayName: 'A', employeeId: 'e1' }),
            await p.assignGroup('ext-1', 'grp-1'),
            await p.issueCredential('ext-1'),
            await p.enableAccount('ext-1'),
        ];
        // `refused`, not `indeterminate`: nothing was attempted, so the
        // directory positively did not change and there is nothing to undo.
        expect(steps.map((s: { kind: string }) => s.kind)).toEqual([
            'refused', 'refused', 'refused', 'refused',
        ]);
    });

    it('a create driven through it stops at REFUSED and touches no rollback', async () => {
        const p = createSnapshotProvisioner('entra-id', ['userPrincipalName']);
        const disableCreated = jest.fn(async () => {});

        const r = await createDirectoryAccount(CTX, req({ provisioner: p, disableCreated }));

        expect(r.kind).toBe('REFUSED');
        expect(disableCreated).not.toHaveBeenCalled();
        // Only the CREATE row was opened — the sequence never reached the group.
        expect(begun).toEqual(['CREATE_ACCOUNT']);
    });
});
