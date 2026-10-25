/** @jest-environment jsdom */

/**
 * The install wizard and the template library (#4125).
 *
 * Both write through `assertCanInstallFrameworkPack`, which reads
 * `frameworks.install`. Before this:
 *   - the wizard had no permission check, so a Reader walked all of it and
 *     was refused at the last click;
 *   - the library's Install buttons rendered for every role, ignored the
 *     response and swallowed every error, so a refused install did nothing
 *     visible, and the bulk one cleared the selection as if it had worked;
 *   - "Suggested Evidence" was a hardcoded DOCUMENT / SCREENSHOT / LOG.
 */
import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/frameworks/ISO27001',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme', frameworkKey: 'ISO27001' }),
}));

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const lookup = (root: unknown, key: string) =>
        key.split('.').reduce(
            (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            root,
        );
    return {
        useTranslations: (ns: string) => (key: string, params?: Record<string, unknown>) => {
            let v = lookup(lookup(en, ns), key);
            if (typeof v !== 'string') return key;
            for (const [p, val] of Object.entries(params ?? {})) v = (v as string).replace(`{${p}}`, String(val));
            return v;
        },
        useLocale: () => 'en',
    };
});

const permissions = { frameworks: { view: true, install: false } };
jest.mock('@/lib/tenant-context-provider', () => ({
    usePermissions: () => permissions,
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path}`,
    useTenantHref: () => (path: string) => `/t/acme${path}`,
}));

import InstallWizardPage from '@/app/t/[tenantSlug]/(app)/frameworks/[frameworkKey]/install/page';
import TemplateLibraryPage from '@/app/t/[tenantSlug]/(app)/frameworks/[frameworkKey]/templates/page';

const en = require('../../messages/en.json');

const FRAMEWORK = { id: 'fw1', key: 'ISO27001', name: 'ISO 27001', version: '2022', description: null, kind: 'ISO_STANDARD', _count: { requirements: 93, packs: 1 } };
const PACKS = [
    { id: 'p1', key: 'iso-base', name: 'ISO base', description: null, version: '1', _count: { templateLinks: 2 } },
    { id: 'p2', key: 'iso-extra', name: 'ISO extra', description: null, version: '1', _count: { templateLinks: 1 } },
];
const TEMPLATES = [
    {
        id: 't1', code: 'A-5.1', title: 'Policies', description: null, category: 'ORGANIZATIONAL', defaultFrequency: null,
        isGlobal: true, installed: false, packs: [], requirements: [],
        tasks: [
            { id: 'k1', title: 'List the topics', description: null, evidenceHint: 'Topic list with the covering policy' },
            { id: 'k2', title: 'Approve', description: null, evidenceHint: 'The approved top-level policy' },
            { id: 'k3', title: 'Approve again', description: null, evidenceHint: 'The approved top-level policy' },
        ],
    },
    {
        id: 't2', code: 'A-5.2', title: 'Roles', description: null, category: 'ORGANIZATIONAL', defaultFrequency: null,
        isGlobal: true, installed: false, packs: [], requirements: [],
        tasks: [{ id: 'k4', title: 'Assign roles', description: null, evidenceHint: null }],
    },
];

type Handler = (url: string, init?: RequestInit) => { ok: boolean; status?: number; body: unknown } | undefined;
let postHandler: Handler = () => undefined;

function json(ok: boolean, body: unknown, status = ok ? 200 : 400) {
    return { ok, status, json: async () => body } as unknown as Response;
}

beforeEach(() => {
    postHandler = () => undefined;
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'POST') {
            const r = postHandler(url, init);
            if (r) return json(r.ok, r.body, r.status);
            return json(true, {});
        }
        if (url.includes('action=packs')) return json(true, PACKS);
        if (url.includes('action=templates')) return json(true, TEMPLATES);
        if (url.includes('action=preview')) return json(true, null);
        return json(true, FRAMEWORK);
    }) as unknown as typeof fetch;
});

afterEach(() => {
    cleanup();
    permissions.frameworks.install = false;
});

describe('the install wizard', () => {
    it('tells a member without frameworks.install who can install, instead of offering the steps', async () => {
        render(<InstallWizardPage />);
        expect(await screen.findByText(en.frameworks.install.restrictedTitle)).toBeTruthy();
        expect(screen.getByText(en.frameworks.install.restricted)).toBeTruthy();
        expect(screen.queryByText(en.frameworks.install.selectAPack)).toBeNull();
        expect(screen.queryByText(en.frameworks.install.stepSelect)).toBeNull();
        expect(document.querySelector('input[type="radio"]')).toBeNull();
    });

    it('offers the steps to a member who holds it', async () => {
        permissions.frameworks.install = true;
        render(<InstallWizardPage />);
        expect(await screen.findByText(en.frameworks.install.selectAPack)).toBeTruthy();
        expect(screen.queryByText(en.frameworks.install.restrictedTitle)).toBeNull();
        expect(document.querySelectorAll('input[type="radio"]').length).toBe(2);
    });
});

describe('the template library', () => {
    it('offers no install control to a member without frameworks.install', async () => {
        render(<TemplateLibraryPage />);
        await screen.findByText('Policies');
        expect(screen.queryByText(en.frameworks.templates.install)).toBeNull();
        expect(document.getElementById('select-all-btn')).toBeNull();
        expect(document.querySelector('#template-list input[type="checkbox"]')).toBeNull();
    });

    it("shows the server's message when a single install is refused", async () => {
        permissions.frameworks.install = true;
        postHandler = () => ({ ok: false, status: 403, body: { error: { code: 'FORBIDDEN', message: 'You do not have permission to install frameworks.' } } });
        render(<TemplateLibraryPage />);
        await screen.findByText('Policies');
        fireEvent.click(screen.getAllByText(en.frameworks.templates.install)[0]);
        expect(await screen.findByText('You do not have permission to install frameworks.')).toBeTruthy();
    });

    it('keeps the selection when a bulk install fails, and says why', async () => {
        permissions.frameworks.install = true;
        postHandler = (url) =>
            url.includes('action=bulk-install')
                ? { ok: false, status: 400, body: { error: { code: 'BAD_REQUEST', message: 'Templates not found: A-5.2' } } }
                : undefined;
        render(<TemplateLibraryPage />);
        await screen.findByText('Policies');
        fireEvent.click(document.getElementById('select-all-btn')!);
        const bulk = await waitFor(() => {
            const b = document.getElementById('bulk-install-btn');
            if (!b) throw new Error('no bulk button');
            return b;
        });
        await act(async () => {
            fireEvent.click(bulk);
        });
        expect(await screen.findByText('Templates not found: A-5.2')).toBeTruthy();
        // Still selected: both boxes ticked and the bulk button still offered.
        const boxes = Array.from(document.querySelectorAll<HTMLInputElement>('#template-list input[type="checkbox"]'));
        expect(boxes).toHaveLength(2);
        expect(boxes.every((b) => b.checked)).toBe(true);
        expect(document.getElementById('bulk-install-btn')!.textContent).toContain('2');
    });

    it("lists the template's own suggested evidence, and none when its tasks name none", async () => {
        render(<TemplateLibraryPage />);
        await screen.findByText('Policies');
        fireEvent.click(screen.getByText('Policies'));
        const evidence = await screen.findByTestId('suggested-evidence-A-5.1');
        expect(evidence.textContent).toContain('Topic list with the covering policy');
        expect(evidence.textContent).toContain('The approved top-level policy');
        // Deduplicated across tasks.
        expect(evidence.textContent!.split('The approved top-level policy').length - 1).toBe(1);
        for (const raw of ['DOCUMENT', 'SCREENSHOT', 'LOG']) expect(evidence.textContent).not.toContain(raw);

        fireEvent.click(screen.getByText('Roles'));
        expect(screen.queryByTestId('suggested-evidence-A-5.2')).toBeNull();
    });
});
