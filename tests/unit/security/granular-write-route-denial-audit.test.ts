/**
 * Seven write routes that asked only the coarse write tier now take the
 * granular key their sibling routes take. A custom role on an Editor base can
 * withhold that key while `canWrite` stays true. For each route:
 *
 *   1. an Editor reaches the usecase (the positive control);
 *   2. an Editor whose custom role withholds the key is refused BEFORE the
 *      usecase runs, and
 *   3. that refusal appends one `AUTHZ_DENIED` entry naming the key.
 */
const mockGetTenantCtx = jest.fn();
const mockAppendAuditEntry = jest.fn();
const mockUpdateRisk = jest.fn();
const mockUpdateRiskFair = jest.fn();
const mockLinkRiskEvidence = jest.fn();
const mockLinkControlToRisk = jest.fn();
const mockMaterializeDelta = jest.fn();
const mockMaterializeNis2 = jest.fn();
const mockRunInTenantContext = jest.fn();

jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (...args: unknown[]) => mockGetTenantCtx(...args),
}));
jest.mock('@/lib/audit', () => ({
    appendAuditEntryOrQueue: (...args: unknown[]) => mockAppendAuditEntry(...args),
    appendAuditEntry: (...args: unknown[]) => mockAppendAuditEntry(...args),
}));
jest.mock('@/app-layer/usecases/risk', () => ({
    updateRisk: (...a: unknown[]) => mockUpdateRisk(...a),
    updateRiskFair: (...a: unknown[]) => mockUpdateRiskFair(...a),
    linkRiskEvidence: (...a: unknown[]) => mockLinkRiskEvidence(...a),
    linkControlToRisk: (...a: unknown[]) => mockLinkControlToRisk(...a),
    getRiskEvidenceTab: jest.fn(),
}));
jest.mock('@/app-layer/usecases/framework-delta', () => ({
    materializeDeltaFindings: (...a: unknown[]) => mockMaterializeDelta(...a),
}));
jest.mock('@/app-layer/usecases/nis2-readiness', () => ({
    materializeNis2Gaps: (...a: unknown[]) => mockMaterializeNis2(...a),
}));
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (...a: unknown[]) => mockRunInTenantContext(...a),
}));
jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));

import type { NextRequest } from 'next/server';
import { makeRequestContext } from '../../helpers/make-context';
import { getPermissionsForRole } from '@/lib/permissions';
import { PATCH as riskStatus } from '@/app/api/t/[tenantSlug]/risks/[id]/status/route';
import { PUT as riskFair } from '@/app/api/t/[tenantSlug]/risks/[id]/fair/route';
import { POST as riskEvidenceAttach } from '@/app/api/t/[tenantSlug]/risks/[id]/evidence/attached/route';
import { POST as riskControlLink } from '@/app/api/t/[tenantSlug]/risks/[id]/controls/route';
import { POST as soaMap } from '@/app/api/t/[tenantSlug]/reports/soa/map/route';
import { POST as deltaMaterialize } from '@/app/api/t/[tenantSlug]/framework-updates/[id]/materialize-findings/route';
import { POST as nis2Materialize } from '@/app/api/t/[tenantSlug]/onboarding/nis2-assessment/materialize/route';

type Handler = (req: NextRequest, args: { params: Promise<Record<string, string>> }) => Promise<Response>;
const asHandler = (h: unknown): Handler => h as Handler;

function makeReq(path: string, method: string, body: unknown): NextRequest {
    return {
        method,
        url: `https://app.example.com${path}`,
        headers: new Headers(),
        nextUrl: { pathname: path, protocol: 'https:', host: 'app.example.com', searchParams: new URLSearchParams() },
        json: async () => body,
    } as unknown as NextRequest;
}

type PermissionSet = ReturnType<typeof getPermissionsForRole>;
/** An Editor-based custom role with the named keys off. */
function editorWithout(keys: Array<[keyof PermissionSet, string]>) {
    const p = getPermissionsForRole('EDITOR') as unknown as Record<string, Record<string, boolean>>;
    const copy: Record<string, Record<string, boolean>> = {};
    for (const [area, v] of Object.entries(p)) copy[area] = { ...v };
    for (const [area, key] of keys) copy[area as string][key] = false;
    return makeRequestContext('EDITOR', { appPermissions: copy as unknown as PermissionSet });
}

const SOA_DB = {
    control: { findFirst: jest.fn(async () => ({ id: 'c-1', code: 'C1', name: 'C' })) },
    frameworkRequirement: { findFirst: jest.fn(async () => ({ id: 'r-1' })) },
    controlRequirementLink: { upsert: jest.fn(async () => ({ id: 'l-1' })) },
};

const ROUTES: Array<{
    name: string;
    handler: Handler;
    method: string;
    path: string;
    params: Record<string, string>;
    body: unknown;
    withheld: Array<[keyof PermissionSet, string]>;
    deniedKey: string;
    reached: jest.Mock;
}> = [
    { name: 'PATCH /risks/:id/status', handler: asHandler(riskStatus), method: 'PATCH', path: '/api/t/acme/risks/r-1/status', params: { tenantSlug: 'acme', id: 'r-1' }, body: { status: 'CLOSED' }, withheld: [['risks', 'edit']], deniedKey: 'risks.edit', reached: mockUpdateRisk },
    { name: 'PUT /risks/:id/fair', handler: asHandler(riskFair), method: 'PUT', path: '/api/t/acme/risks/r-1/fair', params: { tenantSlug: 'acme', id: 'r-1' }, body: { threatEventFrequency: 2 }, withheld: [['risks', 'edit']], deniedKey: 'risks.edit', reached: mockUpdateRiskFair },
    { name: 'POST /risks/:id/evidence/attached', handler: asHandler(riskEvidenceAttach), method: 'POST', path: '/api/t/acme/risks/r-1/evidence/attached', params: { tenantSlug: 'acme', id: 'r-1' }, body: { url: 'https://example.com/e' }, withheld: [['risks', 'edit']], deniedKey: 'risks.edit', reached: mockLinkRiskEvidence },
    { name: 'POST /risks/:id/controls', handler: asHandler(riskControlLink), method: 'POST', path: '/api/t/acme/risks/r-1/controls', params: { tenantSlug: 'acme', id: 'r-1' }, body: { controlId: 'c-1' }, withheld: [['controls', 'edit']], deniedKey: 'controls.edit', reached: mockLinkControlToRisk },
    { name: 'POST /reports/soa/map', handler: asHandler(soaMap), method: 'POST', path: '/api/t/acme/reports/soa/map', params: { tenantSlug: 'acme' }, body: { controlId: 'c-1', requirementId: 'r-1' }, withheld: [['controls', 'edit']], deniedKey: 'controls.edit', reached: mockRunInTenantContext },
    { name: 'POST /framework-updates/:id/materialize-findings', handler: asHandler(deltaMaterialize), method: 'POST', path: '/api/t/acme/framework-updates/d-1/materialize-findings', params: { tenantSlug: 'acme', id: 'd-1' }, body: {}, withheld: [['findings', 'create']], deniedKey: 'findings.create', reached: mockMaterializeDelta },
    { name: 'POST /onboarding/nis2-assessment/materialize (no create)', handler: asHandler(nis2Materialize), method: 'POST', path: '/api/t/acme/onboarding/nis2-assessment/materialize', params: { tenantSlug: 'acme' }, body: {}, withheld: [['findings', 'create']], deniedKey: 'findings.create', reached: mockMaterializeNis2 },
    { name: 'POST /onboarding/nis2-assessment/materialize (no edit)', handler: asHandler(nis2Materialize), method: 'POST', path: '/api/t/acme/onboarding/nis2-assessment/materialize', params: { tenantSlug: 'acme' }, body: {}, withheld: [['findings', 'edit']], deniedKey: 'findings.edit', reached: mockMaterializeNis2 },
];

beforeEach(() => {
    for (const m of [mockGetTenantCtx, mockAppendAuditEntry, mockUpdateRisk, mockUpdateRiskFair, mockLinkRiskEvidence, mockLinkControlToRisk, mockMaterializeDelta, mockMaterializeNis2, mockRunInTenantContext]) m.mockReset();
    mockAppendAuditEntry.mockResolvedValue({ id: 'a1', entryHash: 'h', previousHash: null });
    for (const m of [mockUpdateRisk, mockUpdateRiskFair, mockLinkRiskEvidence, mockLinkControlToRisk, mockMaterializeDelta, mockMaterializeNis2]) m.mockResolvedValue({ id: 'x' });
    mockRunInTenantContext.mockImplementation(async (_ctx: unknown, cb: (db: unknown) => unknown) => cb(SOA_DB));
});

describe.each(ROUTES)('$name', (route) => {
    const call = () =>
        route.handler(makeReq(route.path, route.method, route.body), { params: Promise.resolve(route.params) });

    it('an Editor reaches the usecase', async () => {
        mockGetTenantCtx.mockResolvedValue(makeRequestContext('EDITOR'));
        const res = await call();
        expect(res.status).toBeLessThan(300);
        expect(route.reached).toHaveBeenCalled();
    });

    it(`an Editor-based role without ${route.deniedKey} is refused before the usecase, and the refusal is recorded`, async () => {
        mockGetTenantCtx.mockResolvedValue(editorWithout(route.withheld));
        const res = await call();
        expect(res.status).toBe(403);
        expect(route.reached).not.toHaveBeenCalled();
        const denials = mockAppendAuditEntry.mock.calls
            .map((c) => c[0] as { action: string })
            .filter((e) => e.action === 'AUTHZ_DENIED');
        expect(denials).toHaveLength(1);
        expect(JSON.stringify(denials[0])).toContain(route.deniedKey);
    });
});
