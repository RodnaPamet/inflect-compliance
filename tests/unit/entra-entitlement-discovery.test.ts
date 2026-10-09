/**
 * #3329 — the discovery usecase, and the one check that cannot live in the form.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE CLIENT'S TESTS
 * ──────────────────────────────────────────────────────
 * `policyBelongsToPackage` is tested where it lives. What is NOT tested there is
 * whether anything CALLS it — and a seam is a new collector: deleting the
 * `.filter(...)` in the usecase leaves every assertion about the predicate
 * green while the product offers policies from the wrong package again.
 *
 * That matters more than it sounds. `accessPackageId` and `assignmentPolicyId`
 * are both opaque GUIDs, so a form offering a policy from a DIFFERENT package
 * composes a grant that Graph ACCEPTS — and grants the wrong thing. There is no
 * later error to catch it.
 */
const resolveMock = jest.fn();
const describeMock = jest.fn((r: { kind: string }) => `refusal:${r.kind}`);
jest.mock('@/app-layer/usecases/entra-grant-dispatch', () => ({
    resolveEntraEntitlementConnection: (...a: unknown[]) => resolveMock(...a),
    describeEntitlementRefusal: (r: { kind: string }) => describeMock(r),
}));

const readPackagesMock = jest.fn();
const readPoliciesMock = jest.fn();
jest.mock('@/app-layer/integrations/providers/entra-id/entitlement', () => {
    const actual = jest.requireActual('@/app-layer/integrations/providers/entra-id/entitlement');
    return {
        // SPREAD the real module: `policyBelongsToPackage` is the thing under
        // test here and must be the REAL one, or this file proves only that a
        // double was called.
        ...actual,
        createEntraEntitlementClient: () => ({
            readAccessPackages: readPackagesMock,
            readAssignmentPolicies: readPoliciesMock,
        }),
    };
});

import {
    listAccessPackages,
    listAssignmentPolicies,
} from '@/app-layer/usecases/entra-entitlement-discovery';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('OWNER', { tenantId: 'tenant-A' });
const PKG = 'a914b616-e04e-476b-aa37-91038f0b165b';
const policy = (id: string, accessPackageId: string | null) => ({
    id,
    displayName: `policy ${id}`,
    accessPackageId,
});

beforeEach(() => {
    jest.clearAllMocks();
    resolveMock.mockResolvedValue({ state: 'ok', connection: { clientId: 'c' } });
    readPackagesMock.mockResolvedValue({ items: [], truncated: false });
    readPoliciesMock.mockResolvedValue({ items: [], truncated: false });
});

describe('a connection refusal reaches the caller as its own sentence', () => {
    it.each([
        ['no_connection'],
        ['ambiguous'],
        ['secret_unavailable'],
        ['incomplete_config'],
    ])('%s is passed through, not flattened to "could not load"', async (kind) => {
        // Four causes, four different fixes — connect a directory, disable the
        // extra ones, re-enter a secret, complete the config. A form rendering
        // one message for all four tells an operator nothing.
        resolveMock.mockResolvedValue({ state: 'refused', refusal: { kind } });
        const out = await listAccessPackages(ctx);
        expect(out.ok).toBe(false);
        expect(out.ok === false && out.refused).toBe(`refusal:${kind}`);
    });

    it('does not reach the directory at all when the connection is refused', async () => {
        resolveMock.mockResolvedValue({ state: 'refused', refusal: { kind: 'no_connection' } });
        await listAccessPackages(ctx);
        expect(readPackagesMock).not.toHaveBeenCalled();
    });
});

describe('listAssignmentPolicies drops a policy that does not belong', () => {
    it('keeps the belonging one and DROPS the foreign one', async () => {
        // The far end was asked a filtered question. This is the one place that
        // can check the answer against what was asked.
        readPoliciesMock.mockResolvedValue({
            items: [policy('pol-mine', PKG), policy('pol-foreign', 'some-other-package')],
            truncated: false,
        });
        const out = await listAssignmentPolicies(ctx, PKG);
        expect(out.ok).toBe(true);
        expect(out.ok && out.page.items.map((p) => p.id)).toEqual(['pol-mine']);
    });

    it('drops a policy whose package id came back NULL', async () => {
        // An absent answer is not a yes.
        readPoliciesMock.mockResolvedValue({
            items: [policy('pol-unknown', null)],
            truncated: false,
        });
        const out = await listAssignmentPolicies(ctx, PKG);
        expect(out.ok && out.page.items).toEqual([]);
    });

    it('keeps a wholly-belonging page intact — the positive control', async () => {
        // Paired with the two above, so "drops things" is about belonging and
        // not about this function filtering everything.
        readPoliciesMock.mockResolvedValue({
            items: [policy('a', PKG), policy('b', PKG)],
            truncated: false,
        });
        const out = await listAssignmentPolicies(ctx, PKG);
        expect(out.ok && out.page.items.map((p) => p.id)).toEqual(['a', 'b']);
    });

    it('carries truncation through the filter', async () => {
        // Dropping rows must not be mistaken for, or hide, a truncated read:
        // they are different facts and the form says different things about them.
        readPoliciesMock.mockResolvedValue({
            items: [policy('a', PKG), policy('x', 'other')],
            truncated: true,
        });
        const out = await listAssignmentPolicies(ctx, PKG);
        expect(out.ok && out.page.truncated).toBe(true);
        expect(out.ok && out.page.items).toHaveLength(1);
    });
});

describe('listAccessPackages reports truncation rather than hiding it', () => {
    it('passes truncated through', async () => {
        readPackagesMock.mockResolvedValue({
            items: [{ id: 'p1', displayName: 'P1', description: null, isHidden: false }],
            truncated: true,
        });
        const out = await listAccessPackages(ctx);
        expect(out.ok && out.page.truncated).toBe(true);
    });
});
