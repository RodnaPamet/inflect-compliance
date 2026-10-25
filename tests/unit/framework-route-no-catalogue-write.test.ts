/**
 * No workspace can rewrite the shared framework catalogue (#4125 follow-up).
 *
 * Framework requirements are one global set of rows every workspace reads.
 * `POST /api/t/<slug>/frameworks/<key>?action=upsert-requirements` let any
 * workspace's Owner or Admin rewrite, add or retire them for every other
 * workspace, with no audit row, and no screen called it. The action is gone:
 * the request now falls through to the default (install a pack), whose body
 * schema refuses it, and nothing touches a requirement row.
 */
const installPack = jest.fn();
const frameworkRequirement = { findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() };

jest.mock('@/app-layer/context', () => ({
    // An OWNER: the most a workspace member can be, and who the removed
    // action admitted.
    getTenantCtx: jest.fn(async () => require('./../helpers/make-context').makeRequestContext('OWNER')),
}));
jest.mock('@/app-layer/usecases/framework', () => ({
    ...jest.requireActual('@/app-layer/usecases/framework'),
    installPack: (...args: unknown[]) => installPack(...args),
}));
jest.mock('@/lib/prisma', () => {
    const prisma = { frameworkRequirement, framework: { findFirst: jest.fn(async () => ({ id: 'fw-1', key: 'ISO27001' })) } };
    return { __esModule: true, default: prisma, prisma };
});

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/t/[tenantSlug]/frameworks/[frameworkKey]/route';

function post(action: string, body: unknown) {
    const req = new NextRequest(`http://localhost/api/t/acme/frameworks/ISO27001?action=${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    return POST(req, { params: Promise.resolve({ tenantSlug: 'acme', frameworkKey: 'ISO27001' }) });
}

describe('the framework route has no catalogue writer', () => {
    it('refuses ?action=upsert-requirements and writes no requirement row', async () => {
        const res = await post('upsert-requirements', {
            requirements: [{ code: 'A.5.1', title: 'Rewritten for every workspace' }],
            deprecateMissing: true,
        });

        expect(res.status).toBe(400);
        expect(installPack).not.toHaveBeenCalled();
        for (const write of Object.values(frameworkRequirement)) {
            expect(write).not.toHaveBeenCalled();
        }
    });
});
