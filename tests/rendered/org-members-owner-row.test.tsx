/**
 * THE MEMBERS PAGE READS ORG_OWNER (#4576, deploy 1).
 *
 *   1. An owner row renders with its own label, at the top as the server sorts.
 *   2. A viewer who is not an owner gets the owner row's Change role and Remove
 *      disabled; an owner viewer gets them enabled. Every other row is unchanged,
 *      and a viewer's own row stays disabled either way.
 */
import * as React from 'react';
import { render, screen } from '@testing-library/react';

jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh: jest.fn(), push: jest.fn() }) }));
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, unknown>;
    const resolve = (path: string): unknown =>
        path.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    const make = (ns: string) => (key: string, params?: Record<string, unknown>) => {
        let v = resolve(`${ns}.${key}`);
        if (typeof v !== 'string') return key;
        for (const [p, val] of Object.entries(params ?? {})) v = (v as string).replace(`{${p}}`, String(val));
        return v as string;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

import { MembersTable } from '@/app/org/[orgSlug]/(app)/members/MembersTable';

const EN = (require('../../messages/en.json') as { org: { members: Record<string, string> } }).org.members;

const row = (userId: string, role: 'ORG_OWNER' | 'ORG_ADMIN' | 'ORG_READER') => ({
    membershipId: `m-${userId}`,
    userId,
    role,
    joinedAt: '2026-01-01T00:00:00.000Z',
    user: { id: userId, email: `${userId}@example.com`, name: userId },
});
const ROWS = [row('owner', 'ORG_OWNER'), row('admin', 'ORG_ADMIN'), row('reader', 'ORG_READER')];

function mount(viewerRole: 'ORG_OWNER' | 'ORG_ADMIN', currentUserId: string) {
    render(<MembersTable orgSlug="acme" currentUserId={currentUserId} viewerRole={viewerRole} rows={ROWS} invites={[]} />);
}

describe('the owner row', () => {
    it('renders with the owner label', () => {
        mount('ORG_ADMIN', 'admin');
        expect(screen.getAllByText(EN.roleOrgOwner).length).toBeGreaterThan(0);
    });

    it('is locked for an admin viewer, and the other rows are not', () => {
        mount('ORG_ADMIN', 'admin');
        expect(screen.getByTestId('org-member-role-owner')).toBeDisabled();
        expect(screen.getByTestId('org-member-remove-owner')).toBeDisabled();
        expect(screen.getByTestId('org-member-role-reader')).toBeEnabled();
        expect(screen.getByTestId('org-member-remove-reader')).toBeEnabled();
        // The viewer's own row stays disabled.
        expect(screen.getByTestId('org-member-role-admin')).toBeDisabled();
    });

    it('is open to an owner viewer', () => {
        mount('ORG_OWNER', 'someone-else');
        expect(screen.getByTestId('org-member-role-owner')).toBeEnabled();
        expect(screen.getByTestId('org-member-remove-owner')).toBeEnabled();
    });
});
