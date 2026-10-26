/**
 * Two Evidence dialogs promised what the product does not do (#4277).
 *
 *   - The text-note form invited a link ("Record a link, …", "Paste a link
 *     or narrative…"), but it always creates a TEXT record and the details
 *     panel renders TEXT as plain text, so a pasted link never opens. It now
 *     points at the Link / URL form instead.
 *   - The rejection dialog said the reason "is shared with the owner". The
 *     notification goes only to an owner who is an active member (a text
 *     note's Owner is free text nobody is notified at), so it now says that.
 */
import { render, screen } from '@testing-library/react';
import * as React from 'react';
import { SWRConfig } from 'swr';

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const walk = (root: unknown, path: string) =>
        path.split('.').reduce(
            (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            root,
        );
    return {
        useTranslations: (ns: string) => (key: string) => {
            const v = walk(walk(en, ns), key);
            return typeof v === 'string' ? v : key;
        },
    };
});

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), back: jest.fn(), refresh: jest.fn() }),
    usePathname: () => '/t/acme/evidence',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('@/lib/telemetry/form-telemetry', () => ({
    useFormTelemetry: () => ({ trackSubmit: jest.fn(), trackSuccess: jest.fn(), trackError: jest.fn() }),
}));

import { NewEvidenceTextModal } from '@/app/t/[tenantSlug]/(app)/evidence/NewEvidenceTextModal';
import { RejectReasonModal } from '@/app/t/[tenantSlug]/(app)/evidence/RejectReasonModal';

const EN = require('../../messages/en.json');

describe('the text-note form', () => {
    it('does not invite a link, and points to the Link / URL form', () => {
        render(
            <SWRConfig value={{ provider: () => new Map() }}>
                <NewEvidenceTextModal
                    open
                    setOpen={() => {}}
                    tenantSlug="acme"
                    apiUrl={(p) => `/api/t/acme${p}`}
                    controls={[]}
                />
            </SWRConfig>,
        );
        const content = document.getElementById('text-evidence-content-input') as HTMLTextAreaElement;
        expect(content.placeholder).not.toMatch(/link/i);
        const description = screen.getAllByText(EN.evidence.text.description)[0];
        expect(description.textContent).not.toMatch(/record a link/i);
        // Names the create-menu item that DOES make a link.
        expect(description.textContent).toContain(EN.evidence.list.createLink);
    });
});

describe('the rejection dialog', () => {
    it('says the owner is told only when the owner is a member', () => {
        render(<RejectReasonModal open onClose={() => {}} onConfirm={() => {}} />);
        const text = screen.getAllByText(EN.evidence.reject.description)[0].textContent ?? '';
        expect(text).not.toMatch(/is shared with the owner\./);
        expect(text).toMatch(/member/);
    });
});
