/**
 * What the admin route TELLS an operator the runtime will honour, against what
 * the runtime honours. One value, or the operator is reading a promise nobody
 * keeps.
 *
 * ═══ THE FAILURE THIS EXISTS TO CATCH (#2638) ═══
 *
 * `honoured.joiner.maxMode` was a hand-typed `'DISABLED' as const` in
 * `identity-write-policy/route.ts` while the leaver's came from its pass module.
 * `write-ladder.ts` wrote down what that literal would cost the day the joiner
 * shipped, and it is worth restating because the shape is not obvious: flip
 * `DIRECTION_IMPLEMENTED.joiner` to true and the ladder's refusal disappears, so
 * a tenant climbs — while this response still says the ceiling is DISABLED. The
 * client computes `isAboveClamp(mode, honoured.maxMode)`, which is then TRUE for
 * every rung above off, so it renders the aboveClamp banner permanently, over a
 * pass that is clamping nothing it says it is. Settable-and-inert again, just
 * differently worded.
 *
 * The issue states the acceptance as a mutation: *"flip
 * `DIRECTION_IMPLEMENTED.joiner` without introducing `JOINER_MAX_MODE`, and a
 * test must fail rather than the route silently reporting a DISABLED ceiling."*
 * That is the second test below, and it is run with the flag ACTUALLY FLIPPED —
 * the module is re-loaded against a mocked `write-ladder` — because the flag is
 * false on this branch and an assertion guarded by `if (implemented)` would be a
 * vacuous pass. An empty selection is a PASS, so the selection is made non-empty
 * by hand.
 *
 * ═══ WHY THE COUPLING IS ASSERTED BEHAVIOURALLY, NOT AS A STRING ═══
 *
 * `expect(honoured.joiner.maxMode).toBe('DRY_RUN')` would be one more copy of
 * the literal this change exists to delete — green on the day somebody re-types
 * it in the route and wrong the day the pass's clamp moves. So the third test
 * walks the LADDER and asks the PASS: for each rung, does `planJoinerPass`
 * refuse it as MODE_ABOVE_CLAMP exactly when the route's published ceiling says
 * it should? That is the sentence an operator reads, checked against the code
 * that decides it.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getTenantCtxMock = jest.fn<any, [unknown, unknown]>();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (params: unknown, req: unknown) => getTenantCtxMock(params, req),
}));

// `requirePermission` writes an AUTHZ_DENIED row on denial; it must not reach a
// real database from a guard test. Nothing here denies, but the import graph is
// the same either way.
jest.mock('@/lib/audit', () => ({
    appendAuditEntry: jest.fn(async () => ({ id: 'audit-x', entryHash: 'h', previousHash: null })),
}));

const getPolicyMock = jest.fn(async () => ({
    leaver: { mode: 'DISABLED' as const, dryRunSince: null },
    joiner: { mode: 'DISABLED' as const, dryRunSince: null },
}));
jest.mock('@/app-layer/usecases/identity-write-policy', () => ({
    ...jest.requireActual('@/app-layer/usecases/identity-write-policy'),
    getIdentityWritePolicy: () => getPolicyMock(),
}));

import * as fs from 'node:fs';
import * as path from 'node:path';
import { NextRequest } from 'next/server';

import { GET } from '@/app/api/t/[tenantSlug]/admin/identity-write-policy/route';
import { LEAVER_MAX_MODE } from '@/app-layer/usecases/identity-leaver-pass';
import { JOINER_MAX_MODE, planJoinerPass } from '@/app-layer/usecases/identity-joiner-pass';
import { LADDER, isAboveClamp, type IdentityWriteMode } from '@/lib/identity/write-ladder';
import { getPermissionsForRole } from '@/lib/permissions';
import { braceBlockAfter } from '../helpers/source-blocks';

const ROUTE_REL = 'src/app/api/t/[tenantSlug]/admin/identity-write-policy/route.ts';
const ROUTE_ABS = path.join(process.cwd(), ROUTE_REL);

interface HonouredDirection {
    maxMode: IdentityWriteMode;
    implemented: boolean;
}
interface PolicyBody {
    honoured: { leaver: HonouredDirection; joiner: HonouredDirection };
}

function ownerCtx() {
    return {
        requestId: 'req-1',
        userId: 'owner-1',
        tenantId: 'tenant-A',
        role: 'OWNER' as const,
        permissions: {
            canRead: true,
            canWrite: true,
            canAdmin: true,
            canAudit: true,
            canExport: true,
        },
        appPermissions: getPermissionsForRole('OWNER'),
    };
}

const req = () =>
    new NextRequest('http://localhost/api/t/acme/admin/identity-write-policy', { method: 'GET' });
const routeArgs = { params: Promise.resolve({ tenantSlug: 'acme' }) };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RouteGet = (r: NextRequest, a: any) => Promise<Response>;

async function honouredFrom(get: RouteGet): Promise<PolicyBody['honoured']> {
    getTenantCtxMock.mockResolvedValueOnce(ownerCtx());
    const res = await get(req(), routeArgs);
    expect(res.status).toBe(200);
    return ((await res.json()) as PolicyBody).honoured;
}

beforeEach(() => {
    jest.clearAllMocks();
    getPolicyMock.mockResolvedValue({
        leaver: { mode: 'DISABLED', dryRunSince: null },
        joiner: { mode: 'DISABLED', dryRunSince: null },
    });
});

describe('the published ceiling is the pass constant, for both directions', () => {
    it('reports each direction the constant its own pass enforces', async () => {
        const honoured = await honouredFrom(GET as RouteGet);
        expect(honoured.leaver.maxMode).toBe(LEAVER_MAX_MODE);
        expect(honoured.joiner.maxMode).toBe(JOINER_MAX_MODE);
    });

    it('and the two constants differ, so one value cannot satisfy both assertions', () => {
        // Without this, a route that reported ONE ceiling for both directions
        // would pass the test above the day the two constants happened to meet.
        // It is the denominator for the claim, not decoration.
        expect(LEAVER_MAX_MODE).not.toBe(JOINER_MAX_MODE);
    });

    it('never publishes a joiner ceiling of DISABLED — the literal this replaced', async () => {
        const honoured = await honouredFrom(GET as RouteGet);
        expect(honoured.joiner.maxMode).not.toBe('DISABLED');
    });
});

describe('#2638 acceptance — flipping DIRECTION_IMPLEMENTED.joiner cannot leave a DISABLED ceiling', () => {
    /**
     * Load the route against a write-ladder whose joiner flag is TRUE.
     *
     * The flag is false on this branch, so every "when the joiner is
     * implemented…" assertion would otherwise be a statement about an empty
     * set. Mocking the module is how the mutation the issue names is actually
     * performed, rather than described.
     */
    async function honouredWithJoinerImplemented(): Promise<PolicyBody['honoured']> {
        let mod: { GET: RouteGet } | undefined;
        jest.isolateModules(() => {
            jest.doMock('@/lib/identity/write-ladder', () => ({
                ...jest.requireActual('@/lib/identity/write-ladder'),
                DIRECTION_IMPLEMENTED: { leaver: true, joiner: true },
            }));
            mod = require('@/app/api/t/[tenantSlug]/admin/identity-write-policy/route') as {
                GET: RouteGet;
            };
        });
        if (!mod) throw new Error('the write-policy route failed to load');
        try {
            return await honouredFrom(mod.GET);
        } finally {
            jest.dontMock('@/lib/identity/write-ladder');
        }
    }

    it('takes the flip — the control that says the mutation happened at all', async () => {
        const honoured = await honouredWithJoinerImplemented();
        expect(honoured.joiner.implemented).toBe(true);
    });

    it('reports the joiner pass ceiling, not a DISABLED one, once the direction is implemented', async () => {
        const honoured = await honouredWithJoinerImplemented();
        // THE ACCEPTANCE. With the pre-#2638 route — `maxMode: 'DISABLED' as
        // const` — this is red: a gate that has stopped refusing beside a
        // response that still says the ceiling is off.
        expect(honoured.joiner.maxMode).toBe(JOINER_MAX_MODE);
        expect(honoured.joiner.maxMode).not.toBe('DISABLED');
    });

    it('leaves the leaver exactly as it was, so the flip is scoped', async () => {
        const honoured = await honouredWithJoinerImplemented();
        expect(honoured.leaver.maxMode).toBe(LEAVER_MAX_MODE);
    });
});

describe('the published ceiling agrees with what the pass actually refuses', () => {
    it('matches MODE_ABOVE_CLAMP rung by rung', async () => {
        const honoured = await honouredFrom(GET as RouteGet);
        const plan = (mode: IdentityWriteMode) =>
            planJoinerPass({
                mode,
                now: new Date('2026-09-19T09:00:00.000Z'),
                starters: [
                    {
                        employeeId: 'e1',
                        fullName: 'Jane Smith',
                        workEmail: 'jane.smith@acme.com',
                        source: 'workday',
                        externalId: 'WD-1',
                        department: 'Engineering',
                        startDate: new Date('2026-09-19T00:00:00.000Z'),
                        hasFreshLink: false,
                    },
                ],
                observedAddresses: [],
                departmentGroups: { Engineering: 'grp-eng' },
                defaultGroupId: 'grp-everyone',
                timeZone: 'Europe/Sofia',
            });

        for (const rung of LADDER) {
            expect(plan(rung).refusal === 'MODE_ABOVE_CLAMP').toBe(
                isAboveClamp(rung, honoured.joiner.maxMode),
            );
        }
    });

    it('and at least one rung IS above the published ceiling, so the loop proved something', () => {
        // The positive control for the sweep above. A published ceiling of
        // AUTOMATIC would make every iteration compare false to false — a green
        // loop over a property nobody holds.
        const honouredCeiling = JOINER_MAX_MODE;
        expect(LADDER.filter((r) => isAboveClamp(r, honouredCeiling))).not.toHaveLength(0);
    });
});

describe('the honoured block holds no second spelling of a ceiling', () => {
    it('names both constants and quotes no mode literal', () => {
        // A NARROWED read (`braceBlockAfter`), not the whole file: the route's
        // own comments discuss the `'DISABLED' as const` literal that used to
        // live here, and a whole-file assertion would be satisfied — or
        // falsified — by prose about the defect rather than by the defect.
        const block = braceBlockAfter(fs.readFileSync(ROUTE_ABS, 'utf8'), 'honoured:');
        expect(block).toContain('LEAVER_MAX_MODE');
        expect(block).toContain('JOINER_MAX_MODE');
        // Catches a re-typed literal even when it happens to equal the constant
        // today — which is the drift the import exists to prevent, and which
        // every behavioural test above would sail through.
        expect(block).not.toMatch(/maxMode:\s*['"]/);
    });
});
