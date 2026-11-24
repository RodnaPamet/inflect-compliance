/**
 * The workspace default language's one writer: who may set it, what a change
 * leaves in the audit trail, and what it refuses.
 */
jest.mock('@/lib/db-context', () => ({ runInTenantContext: jest.fn() }));
jest.mock('../../src/app-layer/events/audit', () => ({ logEvent: jest.fn() }));

import { getWorkspaceLanguage, setWorkspaceLanguage } from '@/app-layer/usecases/workspace-language';
import { UpdateWorkspaceLanguageInput } from '@/app-layer/schemas/workspace-language.schemas';
import { runInTenantContext } from '@/lib/db-context';
import { logEvent } from '@/app-layer/events/audit';
import { resolveRoutePermission } from '@/lib/security/route-permissions';
import { makeRequestContext } from '../helpers/make-context';

const mockRunInTx = runInTenantContext as jest.MockedFunction<typeof runInTenantContext>;
const mockLogEvent = logEvent as jest.MockedFunction<typeof logEvent>;

function withTenant(defaultLocale: string) {
    const db = {
        tenant: {
            findUnique: jest.fn().mockResolvedValue({ defaultLocale }),
            update: jest.fn().mockResolvedValue({}),
        },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRunInTx.mockImplementation(async (_c: any, fn: any) => fn(db));
    return db;
}

beforeEach(() => jest.clearAllMocks());

describe('setWorkspaceLanguage', () => {
    it('an admin changes it, and the change is audited with both values', async () => {
        const db = withTenant('en');
        const ctx = makeRequestContext('ADMIN');
        await expect(setWorkspaceLanguage(ctx, { defaultLocale: 'bg' })).resolves.toEqual({ defaultLocale: 'bg' });

        expect(db.tenant.update).toHaveBeenCalledWith({
            where: { id: ctx.tenantId },
            data: { defaultLocale: 'bg' },
        });
        expect(mockLogEvent).toHaveBeenCalledTimes(1);
        const [, , event] = mockLogEvent.mock.calls[0];
        expect(event).toMatchObject({
            action: 'WORKSPACE_LANGUAGE_CHANGED',
            entityType: 'Tenant',
            entityId: ctx.tenantId,
            detailsJson: {
                category: 'entity_lifecycle',
                changedFields: ['defaultLocale'],
                before: { defaultLocale: 'en' },
                after: { defaultLocale: 'bg' },
            },
        });
    });

    it('saving the language already stored writes nothing and audits nothing', async () => {
        const db = withTenant('bg');
        await setWorkspaceLanguage(makeRequestContext('OWNER'), { defaultLocale: 'bg' });
        expect(db.tenant.update).not.toHaveBeenCalled();
        expect(mockLogEvent).not.toHaveBeenCalled();
    });

    it.each(['EDITOR', 'READER', 'AUDITOR'] as const)('refuses a %s before reading or writing anything', async (role) => {
        const db = withTenant('en');
        await expect(setWorkspaceLanguage(makeRequestContext(role), { defaultLocale: 'bg' })).rejects.toThrow(/Admin or Owner/);
        expect(mockRunInTx).not.toHaveBeenCalled();
        expect(db.tenant.update).not.toHaveBeenCalled();
        expect(mockLogEvent).not.toHaveBeenCalled();
    });

    it('refuses a language the product has no catalogue for', async () => {
        withTenant('en');
        await expect(
            setWorkspaceLanguage(makeRequestContext('ADMIN'), { defaultLocale: 'de' } as never),
        ).rejects.toThrow();
        expect(mockLogEvent).not.toHaveBeenCalled();
    });
});

describe('getWorkspaceLanguage', () => {
    it('reads the stored language for an admin', async () => {
        withTenant('bg');
        await expect(getWorkspaceLanguage(makeRequestContext('ADMIN'))).resolves.toEqual({ defaultLocale: 'bg' });
    });

    it('refuses a non-admin', async () => {
        withTenant('bg');
        await expect(getWorkspaceLanguage(makeRequestContext('READER'))).rejects.toThrow(/Admin or Owner/);
    });
});

describe('the route', () => {
    it.each(['GET', 'PUT'])('%s is gated on admin.manage in the route map', (method) => {
        expect(resolveRoutePermission('/api/t/acme/admin/workspace-language', method)?.permission).toBe('admin.manage');
    });
});

describe('the PUT body', () => {
    it('takes exactly one supported locale', () => {
        expect(UpdateWorkspaceLanguageInput.safeParse({ defaultLocale: 'bg' }).success).toBe(true);
        expect(UpdateWorkspaceLanguageInput.safeParse({ defaultLocale: 'fr' }).success).toBe(false);
        expect(UpdateWorkspaceLanguageInput.safeParse({}).success).toBe(false);
        expect(UpdateWorkspaceLanguageInput.safeParse({ defaultLocale: 'en', extra: 1 }).success).toBe(false);
    });
});
