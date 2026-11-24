/**
 * THE INCIDENT PAGE NAMES THE AUTHORITY TO NOTIFY, AND ITS LINK REACHES THE FIELD.
 *
 * The "Notification authority" section used to tell every reader to configure
 * the authority under "tenant security settings" and link
 * `/t/<slug>/admin/settings` — a page that never existed — while the authority
 * the workspace had named (`TenantSecuritySettings.incidentAuthority`) was
 * shown nowhere. The claims pinned here:
 *
 *   1. A named authority is shown, as "Notify: <authority>".
 *   2. A viewer who may set it (the edge admits them to the admin console AND
 *      they hold `admin.manage`) gets a link to the real security settings
 *      page, landing on the field's anchor.
 *   3. A viewer who may not gets no link: with nothing named they are told an
 *      administrator names it; with an authority named they see just that.
 */
import * as React from 'react';
import { render, screen, within } from '@testing-library/react';
import { SWRConfig } from 'swr';

// next-intl is ESM; resolve real en.json values, and render rich-text tags
// through the caller's functions so a link inside a sentence is a real link.
jest.mock('next-intl', () => {
    const React = require('react') as typeof import('react');
    const en = require('../../messages/en.json') as Record<string, Record<string, unknown>>;
    const resolve = (ns: string, key: string): unknown =>
        key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), en[ns]);
    const fill = (v: string, params?: Record<string, unknown>) => {
        let out = v;
        if (params)
            for (const [p, val] of Object.entries(params))
                if (typeof val === 'string' || typeof val === 'number') out = out.replace(new RegExp('\\{' + p + '\\}', 'g'), String(val));
        return out;
    };
    const make = (ns: string) => {
        const t = (key: string, params?: Record<string, unknown>) => {
            const v = resolve(ns, key);
            return typeof v === 'string' ? fill(v, params) : key;
        };
        t.rich = (key: string, params: Record<string, unknown> = {}) => {
            const v = resolve(ns, key);
            if (typeof v !== 'string') return key;
            const text = fill(v, params);
            const parts: React.ReactNode[] = [];
            const re = /<(\w+)>(.*?)<\/\1>/g;
            let last = 0;
            let m: RegExpExecArray | null;
            while ((m = re.exec(text)) !== null) {
                parts.push(text.slice(last, m.index));
                const tag = params[m[1]] as ((c: React.ReactNode) => React.ReactNode) | undefined;
                parts.push(React.createElement(React.Fragment, { key: m.index }, tag ? tag(m[2]) : m[2]));
                last = m.index + m[0].length;
            }
            parts.push(text.slice(last));
            return parts;
        };
        t.has = (key: string) => resolve(ns, key) !== undefined;
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme', incidentId: 'inc_1' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn() }),
    usePathname: () => '/t/acme/incidents/inc_1',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('@/lib/hooks/use-hydrated-now', () => ({
    useHydratedNow: () => new Date('2026-06-02T00:00:00.000Z'),
}));

const mockSWR = jest.fn();
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (...args: unknown[]) => mockSWR(...args),
}));

let mockViewer: { membershipRole: string; adminManage: boolean } = { membershipRole: 'ADMIN', adminManage: true };
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantContext: () => ({
        membershipRole: mockViewer.membershipRole,
        permissions: { canWrite: true, canAdmin: mockViewer.adminManage },
        appPermissions: {
            incidents: { view: true, manage: true },
            tasks: { create: true, edit: true },
            admin: { manage: mockViewer.adminManage },
        },
    }),
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`,
    useTenantHref: () => (path: string) => `/t/acme${path.startsWith('/') ? path : `/${path}`}`,
}));

import IncidentDetailPage from '@/app/t/[tenantSlug]/(app)/incidents/[incidentId]/page';

function incident(notifyAuthority: string | null) {
    return {
        id: 'inc_1',
        reference: 'INC-2026-001',
        title: 'Ransomware on the billing cluster',
        description: '',
        severity: 'HIGH',
        phase: 'CONTAINMENT',
        incidentType: 'RANSOMWARE',
        detectedAt: '2026-06-01T00:00:00.000Z',
        reportable: false,
        reportedAt: null,
        ownerUserId: null,
        linkedControlIds: [],
        completedContainmentSteps: [],
        notifications: [],
        timeline: [],
        evidenceLinks: [],
        notifyAuthority,
    };
}

function renderWith(notifyAuthority: string | null) {
    mockSWR.mockReturnValue({ data: incident(notifyAuthority), isLoading: false, error: null, mutate: jest.fn() });
    render(
        <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>
            <IncidentDetailPage />
        </SWRConfig>,
    );
    return screen.getByTestId('incident-authority');
}

afterEach(() => {
    mockSWR.mockReset();
    mockViewer = { membershipRole: 'ADMIN', adminManage: true };
});

describe('incident notification authority', () => {
    it('shows the authority the workspace named', () => {
        const section = renderWith('BSI (Germany)');
        expect(within(section).getByTestId('incident-authority-name').textContent).toBe('Notify: BSI (Germany)');
        expect(within(section).queryByText(/No notification authority is named/)).toBeNull();
    });

    it('links an admin to the field on the real security settings page', () => {
        const section = renderWith('BSI (Germany)');
        const link = within(section).getByRole('link', { name: 'security settings' });
        expect(link.getAttribute('href')).toBe('/t/acme/admin/security#incident-authority');
        expect(section.textContent).toContain('Change it in security settings.');
    });

    it('with nothing named, tells an admin to name it and links the same field', () => {
        const section = renderWith(null);
        expect(section.textContent).toContain('No notification authority is named for this workspace yet.');
        const link = within(section).getByRole('link', { name: 'security settings' });
        expect(link.getAttribute('href')).toBe('/t/acme/admin/security#incident-authority');
        expect(section.textContent).toContain('Name it in security settings.');
    });

    it('never links to the admin/settings page that does not exist', () => {
        const section = renderWith(null);
        for (const a of within(section).queryAllByRole('link')) {
            expect(a.getAttribute('href')).not.toContain('/admin/settings');
        }
    });

    it.each([
        ['an EDITOR', { membershipRole: 'EDITOR', adminManage: false }],
        // A custom role carrying the key does not open the admin console on an
        // EDITOR membership: the edge refuses it before the route runs.
        ['an EDITOR membership whose custom role holds admin.manage', { membershipRole: 'EDITOR', adminManage: true }],
        ['an ADMIN membership without admin.manage', { membershipRole: 'ADMIN', adminManage: false }],
    ])('%s gets no link, and is told who names it', (_label, viewer) => {
        mockViewer = viewer;
        const section = renderWith(null);
        expect(within(section).queryAllByRole('link')).toHaveLength(0);
        expect(section.textContent).toContain('An administrator names it in the workspace security settings.');
    });

    it('a viewer who may not set it sees a named authority and nothing else', () => {
        mockViewer = { membershipRole: 'READER', adminManage: false };
        const section = renderWith('NCSC-NL (Netherlands)');
        expect(within(section).getByTestId('incident-authority-name').textContent).toBe('Notify: NCSC-NL (Netherlands)');
        expect(within(section).queryAllByRole('link')).toHaveLength(0);
        expect(section.textContent).not.toContain('An administrator names it');
    });
});
