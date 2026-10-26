/**
 * The Evidence library's server page (#4277) — what it reads and what it
 * hands the client.
 *
 *   - A custom role that may view evidence but not controls can open the
 *     page. `listControls` asserts `controls.view`, and the page asked it
 *     unconditionally, so that role got an error page instead of evidence.
 *   - The control list is read one row past the SSR cap, so the client knows
 *     whether it holds every control (`controlsComplete`) or must fetch the
 *     rest; it used to keep the first 100 for good.
 *   - The custom-role evidence grants reach the client (`grants`), because
 *     the coarse `permissions` come from a custom role's BASE role and the
 *     evidence usecases check `appPermissions.evidence.*`.
 */
import * as React from 'react';

const getTenantCtxMock = jest.fn();
const listControlsMock = jest.fn();
const listEvidenceMock = jest.fn();

jest.mock('next-intl/server', () => ({
    getTranslations: async () => (key: string) => key,
}));
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (...a: unknown[]) => getTenantCtxMock(...a),
}));
jest.mock('@/app-layer/usecases/evidence', () => ({
    listEvidence: (...a: unknown[]) => listEvidenceMock(...a),
    getEvidenceRetentionMetrics: async () => ({ total: 0 }),
}));
jest.mock('@/app-layer/usecases/control', () => ({
    listControls: (...a: unknown[]) => listControlsMock(...a),
}));
jest.mock('@/app/t/[tenantSlug]/(app)/evidence/EvidenceClient', () => ({
    EvidenceClient: () => null,
}));

import EvidencePage from '@/app/t/[tenantSlug]/(app)/evidence/page';
import { makeRequestContext } from '../helpers/make-context';

type ClientProps = {
    initialControls: unknown[];
    controlsComplete: boolean;
    canViewControls: boolean;
    grants: { evidenceEdit: boolean; evidenceUpload: boolean; adminManage: boolean };
};

async function render(): Promise<ClientProps> {
    const el = (await EvidencePage({ params: Promise.resolve({ tenantSlug: 'acme' }) })) as React.ReactElement<ClientProps>;
    return el.props;
}

const controls = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, name: `C${i}` }));

beforeEach(() => {
    jest.clearAllMocks();
    listEvidenceMock.mockResolvedValue([]);
    listControlsMock.mockResolvedValue(controls(3));
});

describe('a role that may view evidence but not controls', () => {
    it('opens the page with no control list, and never asks listControls', async () => {
        const ctx = makeRequestContext('EDITOR');
        ctx.appPermissions = { ...ctx.appPermissions, controls: { ...ctx.appPermissions.controls, view: false } };
        getTenantCtxMock.mockResolvedValue(ctx);
        // The real usecase refuses this role; the page must not depend on it.
        listControlsMock.mockRejectedValue(new Error('You do not have permission to view controls.'));

        const props = await render();
        expect(listControlsMock).not.toHaveBeenCalled();
        expect(props.canViewControls).toBe(false);
        expect(props.initialControls).toEqual([]);
    });
});

describe('the control list', () => {
    it('reads one past the cap and reports a short slice as incomplete', async () => {
        getTenantCtxMock.mockResolvedValue(makeRequestContext('EDITOR'));
        listControlsMock.mockResolvedValue(controls(101));

        const props = await render();
        expect(listControlsMock).toHaveBeenCalledWith(expect.anything(), undefined, { take: 101 });
        expect(props.controlsComplete).toBe(false);
        expect(props.initialControls).toHaveLength(100);
        expect(props.canViewControls).toBe(true);
    });

    it('reports a list within the cap as complete', async () => {
        getTenantCtxMock.mockResolvedValue(makeRequestContext('EDITOR'));
        listControlsMock.mockResolvedValue(controls(100));

        const props = await render();
        expect(props.controlsComplete).toBe(true);
        expect(props.initialControls).toHaveLength(100);
    });
});

describe('the evidence grants reach the client', () => {
    it('as the custom role holds them, not as its base role does', async () => {
        const ctx = makeRequestContext('EDITOR');
        ctx.appPermissions = {
            ...ctx.appPermissions,
            evidence: { view: true, upload: true, edit: false, download: true },
        };
        getTenantCtxMock.mockResolvedValue(ctx);

        const props = await render();
        expect(props.grants).toEqual({ evidenceEdit: false, evidenceUpload: true, adminManage: false });
    });

    it('an ADMIN holds admin.manage', async () => {
        getTenantCtxMock.mockResolvedValue(makeRequestContext('ADMIN'));
        const props = await render();
        expect(props.grants).toEqual({ evidenceEdit: true, evidenceUpload: true, adminManage: true });
    });
});
