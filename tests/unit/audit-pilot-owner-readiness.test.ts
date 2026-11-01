/**
 * Whether THIS viewer can set the pilot up, read before the dry run (#4904).
 *
 * The page says which permission or marking is missing instead of opening
 * onto a refusal, so it must ask exactly what the set-up asks: the register
 * key, the tool-exposure key, `tests.create`, and a membership marked SECOND
 * line. The permission half is asked in the page module (one of the keys may be
 * read outside the admin API only there); the line is read by the usecase. And
 * each step the set-up reports carries a kind the page words.
 */
import type { ReactElement } from 'react';

const findFirst = jest.fn();
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) =>
        fn({ tenantMembership: { findFirst } }),
    ),
}));

let mockCtx: unknown;
jest.mock('@/app-layer/context', () => ({ getTenantCtx: jest.fn(async () => mockCtx) }));
jest.mock('@/app-layer/usecases/agent-oversight-settings', () => ({
    oversightReadsFor: jest.fn(async () => ({ decisions: false, receipts: false, quarantine: false })),
}));
jest.mock('next-intl/server', () => ({ getTranslations: jest.fn(async () => (k: string) => k) }));
jest.mock('@/app/t/[tenantSlug]/(app)/agents/audit-pilot/AuditPilotClient', () => ({
    AuditPilotClient: function AuditPilotClient() {
        return null;
    },
}));

import AuditPilotPage from '@/app/t/[tenantSlug]/(app)/agents/audit-pilot/page';
import { kindOfStep, readPilotOwnerLineOfDefence } from '@/app-layer/usecases/audit-pilot-setup';
import { makeRequestContext } from '../helpers/make-context';

type Readiness = { missingPermissions: string[]; lineOfDefence: string | null; ready: boolean };

async function readinessFor(role: string, line: string | null): Promise<Readiness> {
    mockCtx = makeRequestContext(role);
    findFirst.mockResolvedValueOnce({ lineOfDefence: line });
    const element = (await AuditPilotPage({ params: Promise.resolve({ tenantSlug: 'acme' }) })) as ReactElement<{
        readiness: Readiness;
    }>;
    return element.props.readiness;
}

beforeEach(() => findFirst.mockReset());

describe('the page’s readiness', () => {
    it('an Admin marked second line is ready', async () => {
        expect(await readinessFor('ADMIN', 'SECOND')).toEqual({
            missingPermissions: [],
            lineOfDefence: 'SECOND',
            ready: true,
        });
    });

    it('a member with no line declared is not ready, and is told so', async () => {
        expect(await readinessFor('ADMIN', null)).toEqual({
            missingPermissions: [],
            lineOfDefence: null,
            ready: false,
        });
    });

    it('an AI admin can open the page but lacks tests.create', async () => {
        const r = await readinessFor('AI_ADMIN', 'SECOND');
        expect(r.ready).toBe(false);
        expect(r.missingPermissions).toEqual(['tests.create']);
    });
});

describe('readPilotOwnerLineOfDefence', () => {
    it('reads the caller’s own membership in this tenant', async () => {
        findFirst.mockResolvedValueOnce({ lineOfDefence: 'FIRST' });
        const ctx = makeRequestContext('ADMIN');
        expect(await readPilotOwnerLineOfDefence(ctx)).toBe('FIRST');
        expect(findFirst).toHaveBeenCalledWith(
            expect.objectContaining({ where: { tenantId: ctx.tenantId, userId: ctx.userId } }),
        );
    });

    it('is null for a caller with no membership', async () => {
        findFirst.mockResolvedValueOnce(null);
        expect(await readPilotOwnerLineOfDefence(makeRequestContext('ADMIN'))).toBeNull();
    });
});

describe('kindOfStep', () => {
    it('names every step the set-up records', () => {
        expect(kindOfStep('register auditor')).toBe('REGISTER');
        expect(kindOfStep('grant propose_finding')).toBe('GRANT');
        expect(kindOfStep('activate')).toBe('ACTIVATE');
        expect(kindOfStep('plan iam.leaver_timeliness')).toBe('PLAN');
    });
});
