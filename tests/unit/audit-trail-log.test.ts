import { logAudit } from '@/lib/audit-log';
import { withTenantDb } from '@/lib/db-context';
import type { JwtPayload } from '@/lib/auth';
import { Role } from '@prisma/client';

jest.mock('@/lib/db-context', () => ({
    withTenantDb: jest.fn(),
}));

const mockedWithTenantDb = withTenantDb as jest.MockedFunction<typeof withTenantDb>;

function makeSession(overrides: Partial<JwtPayload> = {}): JwtPayload {
    return {
        userId: 'user-1',
        tenantId: 'tenant-1',
        email: 'user@example.com',
        role: Role.ADMIN,
        ...overrides,
    };
}

function makeFakeDb() {
    const create = jest.fn().mockResolvedValue({ id: 'audit-1' });
    return { db: { auditLog: { create } } as any, create };
}

describe('logAudit', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('old signature: logAudit(session, entity, entityId, action, details?)', () => {
        it('wraps the insert in withTenantDb and creates an audit row with details', async () => {
            const session = makeSession();
            const { db, create } = makeFakeDb();

            // withTenantDb invokes its callback with our fake tx
            mockedWithTenantDb.mockImplementation(async (_tenantId, callback) =>
                callback(db)
            );

            await logAudit(session, 'Control', 'control-7', 'UPDATE', 'changed status');

            expect(mockedWithTenantDb).toHaveBeenCalledTimes(1);
            expect(mockedWithTenantDb).toHaveBeenCalledWith(
                'tenant-1',
                expect.any(Function)
            );
            expect(create).toHaveBeenCalledTimes(1);
            expect(create).toHaveBeenCalledWith({
                data: {
                    tenantId: 'tenant-1',
                    userId: 'user-1',
                    entity: 'Control',
                    entityId: 'control-7',
                    action: 'UPDATE',
                    details: 'changed status',
                },
            });
        });

        it('passes undefined details when omitted', async () => {
            const session = makeSession({ userId: 'u2', tenantId: 't2' });
            const { db, create } = makeFakeDb();

            mockedWithTenantDb.mockImplementation(async (_tenantId, callback) =>
                callback(db)
            );

            await logAudit(session, 'Risk', 'risk-1', 'DELETE');

            expect(mockedWithTenantDb).toHaveBeenCalledWith('t2', expect.any(Function));
            expect(create).toHaveBeenCalledWith({
                data: {
                    tenantId: 't2',
                    userId: 'u2',
                    entity: 'Risk',
                    entityId: 'risk-1',
                    action: 'DELETE',
                    details: undefined,
                },
            });
        });
    });

    describe('new signature: logAudit(db, session, entity, entityId, action, details?)', () => {
        it('uses the provided tx directly without calling withTenantDb', async () => {
            const session = makeSession();
            const { db, create } = makeFakeDb();

            await logAudit(db, session, 'Evidence', 'ev-9', 'CREATE', 'uploaded file');

            expect(mockedWithTenantDb).not.toHaveBeenCalled();
            expect(create).toHaveBeenCalledTimes(1);
            expect(create).toHaveBeenCalledWith({
                data: {
                    tenantId: 'tenant-1',
                    userId: 'user-1',
                    entity: 'Evidence',
                    entityId: 'ev-9',
                    action: 'CREATE',
                    details: 'uploaded file',
                },
            });
        });

        it('passes undefined details when the trailing arg is omitted', async () => {
            const session = makeSession({ userId: 'u3', tenantId: 't3' });
            const { db, create } = makeFakeDb();

            await logAudit(db, session, 'Policy', 'pol-2', 'PUBLISH');

            expect(mockedWithTenantDb).not.toHaveBeenCalled();
            expect(create).toHaveBeenCalledWith({
                data: {
                    tenantId: 't3',
                    userId: 'u3',
                    entity: 'Policy',
                    entityId: 'pol-2',
                    action: 'PUBLISH',
                    details: undefined,
                },
            });
        });
    });
});
