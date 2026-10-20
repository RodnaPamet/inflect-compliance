/**
 * The pilot set-up is a PERSON's act (#3807). Since the page reaches it as the
 * signed-in owner, a request carrying an API key, an agent or a job context is
 * refused `OWNER_NOT_A_PERSON` before anything is read — the plans it would
 * write are set only by a person who owns the auditor
 * (`AUDIT_PROCEDURE_PLAN_OWNER_ONLY`), and an owner's own key is not them.
 */
const runInTenantContext = jest.fn(() => {
    throw new Error('read before the person check');
});
jest.mock('@/lib/db-context', () => ({ runInTenantContext }));

import { setUpAuditPilotAsOwner } from '@/app-layer/usecases/audit-pilot-setup';
import { makeRequestContext } from '../helpers/make-context';

describe('setUpAuditPilotAsOwner — a person, never a credential', () => {
    it.each([
        ['an API key', { apiKeyId: 'key_1' }],
        ['an agent', { agentId: 'agt_1' }],
        ['a job', { actorType: 'JOB' as const }],
    ])('refuses %s before any read', async (_label, over) => {
        const ctx = makeRequestContext('OWNER', over);
        for (const apply of [false, true]) {
            const r = await setUpAuditPilotAsOwner(ctx, { apply });
            expect(r).toMatchObject({ ok: false, refusal: 'OWNER_NOT_A_PERSON' });
        }
        expect(runInTenantContext).not.toHaveBeenCalled();
    });

    it('reads the membership for a signed-in person (the paired positive)', async () => {
        await expect(setUpAuditPilotAsOwner(makeRequestContext('OWNER'), { apply: false })).rejects.toThrow(
            'read before the person check',
        );
        expect(runInTenantContext).toHaveBeenCalledTimes(1);
    });
});
