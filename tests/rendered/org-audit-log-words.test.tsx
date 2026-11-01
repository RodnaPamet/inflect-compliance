/**
 * THE ORG AUDIT LOG SAYS WHAT EVERY ENTRY IS (#4849).
 *
 *   1. Each of the ten actions the page did not know renders a label and a
 *      summary in words: no missing key, no empty summary, no stored role,
 *      level or status value.
 *   2. An action a newer deploy wrote renders as "Other event".
 *   3. The action filter re-reads the first page with `action=`, and Load
 *      older keeps the filter.
 */
import * as React from 'react';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

jest.setTimeout(60_000);

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, unknown>;
    const resolve = (path: string): unknown =>
        path.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    const PLURAL = /\{(\w+),\s*plural,((?:\s*(?:=\d+|one|other)\s*\{[^{}]*\})+)\s*\}/g;
    const OPTION = /(=\d+|one|other)\s*\{([^{}]*)\}/g;
    const format = (str: string, params?: Record<string, unknown>) =>
        str
            .replace(PLURAL, (block: string, name: string, options: string) => {
                if (!params || !(name in params)) return block;
                const n = Number(params[name]);
                const forms = new Map<string, string>();
                for (const m of options.matchAll(OPTION)) forms.set(m[1], m[2]);
                const body = forms.get(`=${n}`) ?? (n === 1 ? forms.get('one') : undefined) ?? forms.get('other');
                return body === undefined ? block : body.split('#').join(String(n));
            })
            .replace(/\{(\w+)\}/g, (m: string, name: string) => (params && name in params ? String(params[name]) : m));
    const cache = new Map<string, (key: string, params?: Record<string, unknown>) => string>();
    return {
        useTranslations: (ns: string) => {
            if (!cache.has(ns)) {
                cache.set(ns, (key: string, params?: Record<string, unknown>) => {
                    const v = resolve(`${ns}.${key}`);
                    return typeof v === 'string' ? format(v, params) : `MISSING:${key}`;
                });
            }
            return cache.get(ns);
        },
        useLocale: () => 'en',
    };
});
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/org/acme/audit',
    useSearchParams: () => new URLSearchParams(),
}));

import { AuditLogTable } from '@/app/org/[orgSlug]/(app)/audit/AuditLogTable';

const actor = { id: 'u-1', email: 'owner@example.com', name: 'Olivia Owner' };
let n = 0;
const row = (action: string, detailsJson: unknown) => ({
    id: `e-${++n}`,
    occurredAt: '2026-11-01T09:00:00.000Z',
    action,
    actorType: 'USER',
    actor,
    target: null,
    detailsJson,
    requestId: null,
    entryHash: 'h',
    previousHash: null,
    version: 1,
});

const NEW_ACTIONS: Array<[string, unknown, string, string]> = [
    ['ORG_INVITE_CREATED', { email: 'new@example.com', role: 'ORG_ADMIN' }, 'Invitation sent', 'new@example.com as Org admin'],
    ['ORG_INVITE_REDEEMED', { role: 'ORG_READER' }, 'Invitation accepted', 'Joined as Org reader'],
    ['ORG_INVITE_REVOKED', { email: 'old@example.com', role: 'ORG_READER' }, 'Invitation revoked', 'old@example.com as Org reader'],
    ['ORG_THREAT_LEVEL_SET', { level: 'ELEVATED' }, 'Threat level set', 'Level: Elevated'],
    ['ORG_MATURITY_RATING_SET', { domain: 'PROTECT', level: 'DEFINED' }, 'Maturity rated', 'Protect: 3 · Defined'],
    ['ORG_INITIATIVE_CREATED', { title: 'Roll out MFA' }, 'Initiative created', 'Roll out MFA'],
    ['ORG_INITIATIVE_STATUS_CHANGED', { from: 'PLANNED', to: 'IN_PROGRESS' }, 'Initiative status changed', 'Planned → In progress'],
    ['ORG_AUTHZ_DENIED', { reason: 'OWNER_MEMBERSHIP_NEEDS_OWNER' }, 'Access refused', "Tried to change an owner's membership without being an owner"],
    ['ORG_TENANT_DELETED', { name: 'Acme EU', slug: 'acme-eu', revokedMemberships: 4 }, 'Workspace deleted', 'Acme EU (acme-eu) · 4 memberships ended'],
    ['ORG_AGENT_SWITCHES_CHANGED', { changes: { agentProfiles: { before: true, after: false } } }, 'Agent features changed', 'Agent profiles: on → off'],
];

afterEach(() => {
    delete (globalThis as { fetch?: unknown }).fetch;
});

describe('the org audit log', () => {
    it('labels and summarizes every action it used not to know, in words', () => {
        render(<AuditLogTable orgSlug="acme" initialRows={NEW_ACTIONS.map(([a, d]) => row(a, d)) as never} initialNextCursor={null} />);
        const table = document.body;
        for (const [, , label, summary] of NEW_ACTIONS) {
            expect(within(table).getAllByText(label).length).toBeGreaterThan(0);
            expect(within(table).getByText(summary)).toBeInTheDocument();
        }
        expect(table.textContent ?? '').not.toMatch(/MISSING:|ORG_(ADMIN|READER|OWNER)|ELEVATED|IN_PROGRESS/);
    });

    it('says role changes in words', () => {
        render(
            <AuditLogTable
                orgSlug="acme"
                initialRows={[row('ORG_MEMBER_ROLE_CHANGED', { previousRole: 'ORG_READER', newRole: 'ORG_ADMIN' })] as never}
                initialNextCursor={null}
            />,
        );
        expect(screen.getByText('Org reader → Org admin')).toBeInTheDocument();
    });

    it('names an action this build does not know as "Other event"', () => {
        render(<AuditLogTable orgSlug="acme" initialRows={[row('ORG_SOMETHING_NEW', {})] as never} initialNextCursor={null} />);
        expect(screen.getByText('Other event')).toBeInTheDocument();
    });

    it('filters by action through the API, and Load older keeps the filter', async () => {
        const user = userEvent.setup();
        const urls: string[] = [];
        (globalThis as { fetch?: unknown }).fetch = jest.fn(async (url: string) => {
            urls.push(url);
            const page = urls.length === 1
                ? { rows: [row('ORG_INVITE_CREATED', { email: 'a@example.com', role: 'ORG_ADMIN' })], nextCursor: 'c2' }
                : { rows: [row('ORG_INVITE_CREATED', { email: 'b@example.com', role: 'ORG_READER' })], nextCursor: null };
            return { ok: true, status: 200, json: async () => page };
        }) as unknown as typeof fetch;

        render(<AuditLogTable orgSlug="acme" initialRows={[row('ORG_MEMBER_ADDED', { role: 'ORG_READER' })] as never} initialNextCursor={null} />);
        await user.click(screen.getByRole('combobox', { name: 'Filter by action' }));
        await user.click(await screen.findByRole('option', { name: 'Invitation sent' }));

        await waitFor(() => expect(screen.getByText('a@example.com as Org admin')).toBeInTheDocument());
        expect(screen.queryByText('Role: Org reader')).toBeNull();
        expect(urls[0]).toBe('/api/org/acme/audit-log?limit=20&action=ORG_INVITE_CREATED');

        await user.click(screen.getByTestId('org-audit-load-more'));
        await waitFor(() => expect(screen.getByText('b@example.com as Org reader')).toBeInTheDocument());
        expect(urls[1]).toBe('/api/org/acme/audit-log?limit=20&cursor=c2&action=ORG_INVITE_CREATED');
    });
});
