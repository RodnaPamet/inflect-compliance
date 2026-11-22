/** @jest-environment jsdom */

/**
 * A mounted UpgradeGate survives the tenant's plan changing under it (#5309).
 *
 * The translator used to be read only on the locked path, after the early
 * returns, so a plan moving from one that includes the feature to one that
 * does not changed the number of hooks between renders, and React threw.
 *
 * The repo-wide next-intl mock is a plain function, not a hook, so it could
 * never show this; this suite's `useTranslations` is a real hook.
 */
import * as React from 'react';
import { render, screen } from '@testing-library/react';

jest.mock('next-intl', () => {
    const React = jest.requireActual('react');
    return {
        useTranslations: () => {
            // A real hook, as next-intl's is.
            const [t] = React.useState(() => {
                const fn = (key: string) => key;
                fn.has = () => false;
                return fn;
            });
            return t;
        },
    };
});

const mockCtx: { plan: string | null } = { plan: 'ENTERPRISE' };
jest.mock('@/lib/tenant-context-provider', () => {
    const React = jest.requireActual('react');
    return {
        useTenantContext: () => mockCtx,
        // A real hook, as the provider's `useCallback` one is — React keys the
        // update dispatcher on the component already holding hook state.
        useTenantHref: () => React.useCallback((path: string) => `/t/acme${path}`, []),
    };
});

import { UpgradeGate } from '@/components/UpgradeGate';

describe('UpgradeGate — a plan change while mounted', () => {
    it('re-renders from an included plan to a locked one without a hook-order error', () => {
        mockCtx.plan = 'ENTERPRISE';
        const { rerender } = render(
            <UpgradeGate feature="AUDIT_PACK_SHARING">
                <button type="button">Share</button>
            </UpgradeGate>,
        );
        expect(screen.getByRole('button', { name: 'Share' })).toBeTruthy();
        expect(screen.queryByText('PRO')).toBeNull();

        mockCtx.plan = 'FREE';
        rerender(
            <UpgradeGate feature="AUDIT_PACK_SHARING">
                <button type="button">Share</button>
            </UpgradeGate>,
        );
        // Locked: the upgrade link names the plan the feature needs.
        expect(screen.getByText('PRO')).toBeTruthy();
    });

    it('and back again', () => {
        mockCtx.plan = 'FREE';
        const { rerender } = render(
            <UpgradeGate feature="AUDIT_PACK_SHARING">
                <button type="button">Share</button>
            </UpgradeGate>,
        );
        expect(screen.getByText('PRO')).toBeTruthy();
        mockCtx.plan = 'PRO';
        rerender(
            <UpgradeGate feature="AUDIT_PACK_SHARING">
                <button type="button">Share</button>
            </UpgradeGate>,
        );
        expect(screen.queryByText('PRO')).toBeNull();
    });
});
