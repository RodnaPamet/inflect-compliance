/** @jest-environment jsdom */

/**
 * The assessment pre-fill panel words an extraction refusal (#5764).
 *
 * Every refusal used to read "Extraction failed": AI switched off, the AI rate
 * limit, a document of another vendor and an AI Guard block alike. A refusal
 * whose `details.reason` the panel knows is worded in the reader's language;
 * any other shows the server's own message; the generic sentence is left only
 * for a refusal that carries neither.
 */
import * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

// A stable translator per namespace, as next-intl gives.
jest.mock('next-intl', () => {
    const shared = jest.requireActual('../../__mocks__/next-intl.js');
    const translators = new Map<string, unknown>();
    return {
        ...shared,
        useTranslations: (ns: string) => {
            if (!translators.has(ns)) translators.set(ns, shared.useTranslations(ns));
            return translators.get(ns);
        },
    };
});

jest.mock('@/lib/tenant-context-provider', () => {
    const apiUrl = (path: string) => `/api/t/acme${path}`;
    return { useTenantApiUrl: () => apiUrl };
});

import { AssessmentPrefillPanel } from '@/app/t/[tenantSlug]/(app)/admin/vendor-assessment-reviews/[assessmentId]/_components/AssessmentPrefillPanel';

const EN = jest.requireActual('../../messages/en.json') as {
    vendors: { prefill: Record<string, string> & { refused: Record<string, string> } };
};
const BG = jest.requireActual('../../messages/bg.json') as typeof EN;
const P = EN.vendors.prefill;

function json(status: number, body: unknown) {
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

/** The document list answers; the extract answers `extract`. */
function serve(extract: Response) {
    global.fetch = jest.fn(async (url: string) => {
        if (url.endsWith('/vendors/v-1/documents')) {
            return json(200, [{ id: 'doc-1', type: 'SOC2', title: 'SOC 2 report' }]);
        }
        if (url.endsWith('/documents/doc-1/extract')) return extract;
        throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;
}

async function prefill(): Promise<string> {
    render(<AssessmentPrefillPanel vendorId="v-1" assessmentId="as-1" />);
    const button = await screen.findByRole('button', { name: P.prefillBtn });
    // The first document is selected once the list arrives.
    await screen.findByText('SOC 2 report');
    fireEvent.click(button);
    return (await screen.findByTestId('prefill-error')).textContent ?? '';
}

function refusal(code: string, message: string, details?: Record<string, unknown>) {
    return { error: { code, message, ...(details ? { details } : {}) } };
}

describe('AssessmentPrefillPanel — an extraction refusal says why', () => {
    it.each([
        ['AI_DISABLED', 403, refusal('FORBIDDEN', 'AI features are currently disabled', { reason: 'AI_DISABLED' })],
        [
            'AI_TURNED_OFF_FOR_WORKSPACE',
            403,
            refusal('FORBIDDEN', 'AI features are turned off for this workspace', { reason: 'AI_TURNED_OFF_FOR_WORKSPACE' }),
        ],
        [
            'AI_TOO_MANY_REQUESTS',
            429,
            refusal('RATE_LIMITED', 'Too many AI assessment requests.', { reason: 'AI_TOO_MANY_REQUESTS' }),
        ],
        [
            'AI_GUARD_BLOCKED',
            403,
            refusal('FORBIDDEN', 'ai_guard_blocked: input malicious [inj.1]', { reason: 'AI_GUARD_BLOCKED' }),
        ],
        [
            'DOCUMENT_VENDOR_MISMATCH',
            400,
            refusal('BAD_REQUEST', 'This document belongs to a different vendor.', { reason: 'DOCUMENT_VENDOR_MISMATCH' }),
        ],
    ])('words %s from its reason', async (reason, status, body) => {
        serve(json(status, body));
        const shown = await prefill();
        expect(shown).toBe(P.refused[reason]);
        expect(shown).not.toBe(P.extractionFailed);
    });

    it('says when the daily allowance resets', async () => {
        serve(
            json(
                429,
                refusal('RATE_LIMITED', 'AI assessment daily limit reached (100/day). Resets in ~42 minutes.', {
                    reason: 'AI_DAILY_LIMIT_REACHED',
                    limit: 100,
                    resetInMinutes: 42,
                }),
            ),
        );
        expect(await prefill()).toBe(P.refused.AI_DAILY_LIMIT_REACHED_RESET.replace('{minutes}', '42'));
    });

    it('shows the server\'s message for a refusal it does not know', async () => {
        serve(json(404, refusal('NOT_FOUND', 'Vendor document not found')));
        expect(await prefill()).toBe('Vendor document not found');
    });

    it('keeps the generic sentence only for a refusal with no message at all', async () => {
        serve({ ok: false, status: 502, json: async () => { throw new Error('not json'); } } as unknown as Response);
        expect(await prefill()).toBe(P.extractionFailed);
    });

    it('has a Bulgarian sentence for every reason it words', () => {
        const en = Object.keys(EN.vendors.prefill.refused).sort();
        const bg = BG.vendors.prefill.refused;
        expect(Object.keys(bg).sort()).toEqual(en);
        for (const key of en) expect(bg[key]).toMatch(/[Ѐ-ӿ]/);
    });
});
