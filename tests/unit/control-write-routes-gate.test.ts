/**
 * The control page's write routes that had no route-level gate now carry one
 * (#4387), each with the key its usecase already asserts:
 *
 *   POST /controls/:id/status                               controls.edit  (assertCanUpdateControl)
 *   POST /controls/:id/owner                                controls.edit  (assertCanUpdateControl)
 *   POST /controls/:id/applicability                        controls.edit  (assertCanSetApplicability)
 *   POST /controls/:id/contributors                         controls.edit  (assertCanUpdateControl)
 *   POST /controls/:id/requirements/:reqId/applicability    controls.edit  (assertCanSetApplicability)
 *   POST /controls/:id/tests/plans                          tests.create   (assertCanManageTestPlans)
 *   POST /tests/plans/:planId/runs                          tests.execute  (assertCanExecuteTests)
 *
 * So no role gains or loses anything. What the gate adds is the record: a
 * `requirePermission` refusal writes a hash-chained AUTHZ_DENIED row, and the
 * usecase's `forbidden()` throw writes nothing.
 *
 * Each row is proved four ways: a caller without the key gets a 403, one
 * AUTHZ_DENIED row naming the key and no usecase call; a built-in EDITOR
 * reaches the usecase with the body intact; authorization runs BEFORE body
 * parsing (an unauthorized caller with a broken body still gets 403, not 400);
 * and an authorized caller's body is still validated.
 */
import { strictMock } from '../helpers/strict-mock';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getTenantCtxMock = jest.fn<any, [unknown, unknown]>();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (params: unknown, req: unknown) => getTenantCtxMock(params, req),
}));

const mockAppendAuditEntryOrQueue = jest.fn(async (_entry: unknown) => ({
    recorded: 'chain' as const,
    auditId: 'audit-x',
}));
jest.mock('@/lib/audit', () =>
    strictMock('@/lib/audit', jest.requireActual('@/lib/audit'), {
        appendAuditEntryOrQueue: (entry: unknown) => mockAppendAuditEntryOrQueue(entry),
    }),
);

const usecase = {
    setControlStatus: jest.fn(async (..._a: unknown[]) => ({ id: 'ctrl-1' })),
    setControlOwner: jest.fn(async (..._a: unknown[]) => ({ id: 'ctrl-1' })),
    setControlApplicability: jest.fn(async (..._a: unknown[]) => ({ id: 'ctrl-1' })),
    addContributor: jest.fn(async (..._a: unknown[]) => ({ userId: 'user-2' })),
    listContributors: jest.fn(async (..._a: unknown[]) => []),
    setRequirementLinkApplicability: jest.fn(async (..._a: unknown[]) => ({ id: 'map-1' })),
    createTestPlan: jest.fn(async (..._a: unknown[]) => ({ id: 'plan-1' })),
    listControlTestPlans: jest.fn(async (..._a: unknown[]) => []),
    createTestRun: jest.fn(async (..._a: unknown[]) => ({ id: 'run-1' })),
};
jest.mock('@/app-layer/usecases/control', () => ({
    setControlStatus: (...a: unknown[]) => usecase.setControlStatus(...a),
    setControlOwner: (...a: unknown[]) => usecase.setControlOwner(...a),
    setControlApplicability: (...a: unknown[]) => usecase.setControlApplicability(...a),
    addContributor: (...a: unknown[]) => usecase.addContributor(...a),
    listContributors: (...a: unknown[]) => usecase.listContributors(...a),
    setRequirementLinkApplicability: (...a: unknown[]) => usecase.setRequirementLinkApplicability(...a),
    createTestPlan: (...a: unknown[]) => usecase.createTestPlan(...a),
    listControlTestPlans: (...a: unknown[]) => usecase.listControlTestPlans(...a),
    createTestRun: (...a: unknown[]) => usecase.createTestRun(...a),
}));

import { NextRequest } from 'next/server';
import { POST as postStatus } from '@/app/api/t/[tenantSlug]/controls/[controlId]/status/route';
import { POST as postOwner } from '@/app/api/t/[tenantSlug]/controls/[controlId]/owner/route';
import { POST as postApplicability } from '@/app/api/t/[tenantSlug]/controls/[controlId]/applicability/route';
import { POST as postContributor } from '@/app/api/t/[tenantSlug]/controls/[controlId]/contributors/route';
import { POST as postRequirementApplicability } from '@/app/api/t/[tenantSlug]/controls/[controlId]/requirements/[requirementId]/applicability/route';
import { POST as postTestPlan } from '@/app/api/t/[tenantSlug]/controls/[controlId]/tests/plans/route';
import { POST as postTestRun } from '@/app/api/t/[tenantSlug]/tests/plans/[planId]/runs/route';
import { getPermissionsForRole, type PermissionSet } from '@/lib/permissions';

const editor = {
    requestId: 'req-1',
    userId: 'editor-1',
    tenantId: 'tenant-A',
    role: 'EDITOR',
    permissions: { canRead: true, canWrite: true, canAdmin: false, canAudit: false, canExport: true },
    appPermissions: getPermissionsForRole('EDITOR'),
};

/** A custom role on an EDITOR base with one key switched off. */
function editorWithout(key: string) {
    const [domain, action] = key.split('.') as [keyof PermissionSet, string];
    const base = getPermissionsForRole('EDITOR');
    return {
        ...editor,
        userId: 'custom-1',
        appPermissions: { ...base, [domain]: { ...base[domain], [action]: false } },
    };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (req: NextRequest, args: { params: Promise<any> }) => Promise<Response>;

interface Row {
    name: string;
    handler: Handler;
    url: string;
    params: Record<string, string>;
    key: string;
    usecase: keyof typeof usecase;
    /** null for a route with no body. */
    body: unknown;
    /** A body the route's schema refuses; null for a route with no body. */
    badBody: unknown;
    status: number;
    /** What the usecase must receive after `ctx`. */
    args: unknown[];
}

const CTRL = { tenantSlug: 'acme', controlId: 'ctrl-1' };

const ROWS: Row[] = [
    {
        name: 'POST /controls/:id/status',
        handler: postStatus as Handler,
        url: '/api/t/acme/controls/ctrl-1/status',
        params: CTRL,
        key: 'controls.edit',
        usecase: 'setControlStatus',
        body: { status: 'IMPLEMENTED' },
        badBody: { status: 'NOT_A_STATUS' },
        status: 200,
        args: ['ctrl-1', 'IMPLEMENTED'],
    },
    {
        name: 'POST /controls/:id/owner',
        handler: postOwner as Handler,
        url: '/api/t/acme/controls/ctrl-1/owner',
        params: CTRL,
        key: 'controls.edit',
        usecase: 'setControlOwner',
        body: { ownerUserId: 'user-9' },
        badBody: { ownerUserId: 42 },
        status: 200,
        args: ['ctrl-1', 'user-9'],
    },
    {
        name: 'POST /controls/:id/applicability',
        handler: postApplicability as Handler,
        url: '/api/t/acme/controls/ctrl-1/applicability',
        params: CTRL,
        key: 'controls.edit',
        usecase: 'setControlApplicability',
        body: { applicability: 'NOT_APPLICABLE', justification: 'Out of scope' },
        badBody: { applicability: 'MAYBE' },
        status: 200,
        args: ['ctrl-1', 'NOT_APPLICABLE', 'Out of scope'],
    },
    {
        name: 'POST /controls/:id/contributors',
        handler: postContributor as Handler,
        url: '/api/t/acme/controls/ctrl-1/contributors',
        params: CTRL,
        key: 'controls.edit',
        usecase: 'addContributor',
        body: { userId: 'user-2' },
        badBody: {},
        status: 201,
        args: ['ctrl-1', 'user-2'],
    },
    {
        name: 'POST /controls/:id/requirements/:requirementId/applicability',
        handler: postRequirementApplicability as Handler,
        url: '/api/t/acme/controls/ctrl-1/requirements/req-1/applicability',
        params: { ...CTRL, requirementId: 'req-1' },
        key: 'controls.edit',
        usecase: 'setRequirementLinkApplicability',
        body: { applicability: null },
        badBody: { applicability: 'MAYBE' },
        status: 200,
        args: ['ctrl-1', 'req-1', null, null],
    },
    {
        name: 'POST /controls/:id/tests/plans',
        handler: postTestPlan as Handler,
        url: '/api/t/acme/controls/ctrl-1/tests/plans',
        params: CTRL,
        key: 'tests.create',
        usecase: 'createTestPlan',
        body: { name: 'Quarterly review', frequency: 'QUARTERLY' },
        badBody: { frequency: 'QUARTERLY' },
        status: 201,
        args: ['ctrl-1', { name: 'Quarterly review', frequency: 'QUARTERLY' }],
    },
    {
        name: 'POST /tests/plans/:planId/runs',
        handler: postTestRun as Handler,
        url: '/api/t/acme/tests/plans/plan-1/runs',
        params: { tenantSlug: 'acme', planId: 'plan-1' },
        key: 'tests.execute',
        usecase: 'createTestRun',
        body: null,
        badBody: null,
        status: 201,
        args: ['plan-1'],
    },
];

function call(row: Row, body: unknown, raw?: string) {
    const init: { method: string; headers?: Record<string, string>; body?: string } = { method: 'POST' };
    if (raw !== undefined || body !== null) {
        init.headers = { 'Content-Type': 'application/json' };
        init.body = raw ?? JSON.stringify(body);
    }
    return row.handler(new NextRequest(`http://localhost${row.url}`, init), {
        params: Promise.resolve(row.params),
    });
}

beforeEach(() => {
    getTenantCtxMock.mockReset();
    getTenantCtxMock.mockResolvedValue(editor);
    for (const fn of Object.values(usecase)) fn.mockClear();
    mockAppendAuditEntryOrQueue.mockClear();
});

describe.each(ROWS)('$name is gated $key at the route', (row) => {
    it('refuses a caller without the key with a 403 and an AUTHZ_DENIED row, and never calls the usecase', async () => {
        getTenantCtxMock.mockResolvedValue(editorWithout(row.key));
        const res = await call(row, row.body);
        expect(res.status).toBe(403);
        expect(usecase[row.usecase]).not.toHaveBeenCalled();
        expect(mockAppendAuditEntryOrQueue).toHaveBeenCalledTimes(1);
        expect(mockAppendAuditEntryOrQueue.mock.calls[0][0]).toMatchObject({
            action: 'AUTHZ_DENIED',
            tenantId: 'tenant-A',
            userId: 'custom-1',
            detailsJson: expect.objectContaining({ permissionKeys: [row.key] }),
        });
        // A generic refusal: the key is not echoed to the client.
        expect(JSON.stringify(await res.json())).not.toContain(row.key);
    });

    it('a READER is refused the same way', async () => {
        getTenantCtxMock.mockResolvedValue({
            ...editor,
            role: 'READER',
            permissions: { canRead: true, canWrite: false, canAdmin: false, canAudit: false, canExport: false },
            appPermissions: getPermissionsForRole('READER'),
        });
        const res = await call(row, row.body);
        expect(res.status).toBe(403);
        expect(usecase[row.usecase]).not.toHaveBeenCalled();
        expect(mockAppendAuditEntryOrQueue).toHaveBeenCalledTimes(1);
    });

    it('a built-in EDITOR reaches the usecase with the request intact', async () => {
        const res = await call(row, row.body);
        expect(res.status).toBe(row.status);
        expect(usecase[row.usecase]).toHaveBeenCalledTimes(1);
        const [ctx, ...rest] = usecase[row.usecase].mock.calls[0];
        expect(ctx).toBe(editor);
        expect(rest).toEqual(row.args);
        expect(mockAppendAuditEntryOrQueue).not.toHaveBeenCalled();
    });

    if (row.badBody !== null) {
        it('authorizes before it parses: no key and a broken body is still a 403', async () => {
            getTenantCtxMock.mockResolvedValue(editorWithout(row.key));
            const res = await call(row, null, '{not json');
            expect(res.status).toBe(403);
            expect(usecase[row.usecase]).not.toHaveBeenCalled();
        });

        it('still validates the body for a caller the gate admits', async () => {
            const res = await call(row, row.badBody);
            expect(res.status).toBe(400);
            expect(usecase[row.usecase]).not.toHaveBeenCalled();
            expect(mockAppendAuditEntryOrQueue).not.toHaveBeenCalled();
        });
    }
});
