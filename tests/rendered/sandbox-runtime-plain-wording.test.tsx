/**
 * #4825 — the Sandbox runtime page says where the enforcement rules are fixed
 * in plain words, and never prints a source path or a CI check's name.
 *
 * The citation still exists (`displayForEnforcement().setInCode`, verified by
 * `tests/guards/sandbox-runtime-tier-c-stays-read-only.test.ts`); it is an
 * engineering reference, not something a workspace admin can act on.
 */
import { render, screen, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantHref: () => (path: string) => `/t/acme${path}`,
}));
jest.mock('@/components/nav/BackAffordance', () => ({ BackAffordance: () => null }));

import { SandboxRuntimeClient } from '@/app/t/[tenantSlug]/(app)/admin/sandbox-runtime/SandboxRuntimeClient';
import {
    TIER_C_CI_CHECK,
    TIER_C_POLICY_MODULE,
} from '@/app/t/[tenantSlug]/(app)/admin/sandbox-runtime/sandbox-runtime-display';

const EN = jest.requireActual('../../messages/en.json') as {
    admin: { sandboxRuntime: Record<string, string> };
};

afterEach(cleanup);

function renderPage() {
    return render(
        <NextIntlClientProvider locale="en" messages={EN as unknown as Record<string, unknown>}>
            <SandboxRuntimeClient
                platformEnabled={false}
                view={{
                    configured: true,
                    configDigest: 'sha256:abc',
                    reachableVersion: '0.1.6',
                    probeOutcome: 'answered',
                    probedAtIso: '2026-10-31T10:00:00.000Z',
                    channels: {
                        'anonymous-telemetry': null,
                        'otlp-traces': null,
                        'ocsf-file': null,
                        'ocsf-over-otlp': null,
                    },
                    appliedAtIso: null,
                } as unknown as Parameters<typeof SandboxRuntimeClient>[0]['view']}
            />
        </NextIntlClientProvider>,
    );
}

describe('Sandbox runtime enforcement rows', () => {
    it('name where the rule is fixed in plain words, for both rules', () => {
        renderPage();
        expect(screen.getByTestId('policy-module-enforcement')).toHaveTextContent(
            EN.admin.sandboxRuntime.policyModuleValue,
        );
        expect(screen.getByTestId('policy-module-landlock-compatibility')).toHaveTextContent(
            EN.admin.sandboxRuntime.policyModuleValue,
        );
        expect(screen.getByTestId('ci-check-enforcement')).toHaveTextContent(
            EN.admin.sandboxRuntime.ciCheckValue,
        );
    });

    it('never print the source path or the check name', () => {
        const { container } = renderPage();
        expect(container.textContent).not.toContain(TIER_C_POLICY_MODULE);
        expect(container.textContent).not.toContain(TIER_C_CI_CHECK);
        expect(container.textContent).not.toMatch(/src\/lib\//);
    });
});
