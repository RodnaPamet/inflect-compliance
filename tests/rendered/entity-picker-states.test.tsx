/** @jest-environment jsdom */

/**
 * EntityPicker says what it found, in the reader's language (#5309).
 *
 *   - A refused or failed candidate load reads "Couldn't load …", not
 *     "No … available": a member whose role lacks `vendors.view` concluded the
 *     tenant had no vendors.
 *   - The noun is translated per kind. It was the enum lower-cased with an
 *     "s" appended — "No policys available" in English, an English noun in a
 *     Bulgarian sentence.
 */
import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';

const mockCatalogue: { messages: Record<string, unknown> } = {
    messages: require('../../messages/en.json'),
};
jest.mock('next-intl', () => {
    const walk = (root: unknown, path: string) =>
        path.split('.').reduce(
            (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            root,
        );
    const make = (ns: string) => {
        const lookup = (key: string) => walk(mockCatalogue.messages, ns ? `${ns}.${key}` : key);
        const t = (key: string, values?: Record<string, unknown>) => {
            const v = lookup(key);
            if (typeof v !== 'string') return key;
            return v.replace(/\{(\w+)\}/g, (m, name) => (values && name in values ? String(values[name]) : m));
        };
        t.has = (key: string) => typeof lookup(key) === 'string';
        return t;
    };
    // Built per call, so it reads whichever catalogue is current. The
    // picker's load effect is not keyed on `t`.
    return { useTranslations: (ns = '') => make(ns), useLocale: () => 'en' };
});

const EN = require('../../messages/en.json');
const BG = require('../../messages/bg.json');

import { EntityPicker } from '@/components/ui/entity-picker';

function answer(status: number, body: unknown) {
    global.fetch = jest.fn(async () => ({ ok: status < 300, status, json: async () => body })) as unknown as typeof fetch;
}

const trigger = () => screen.getByTestId('entity-picker');

afterEach(() => {
    mockCatalogue.messages = EN;
});

describe('EntityPicker', () => {
    it('a refused load says it could not load, not that there are none', async () => {
        answer(403, { error: { code: 'FORBIDDEN', message: 'Forbidden' } });
        render(<EntityPicker tenantSlug="acme" entityType="VENDOR" value="" onChange={jest.fn()} />);
        await waitFor(() => expect(trigger().textContent).toContain("Couldn't load vendors"));
        expect(trigger().textContent).not.toContain('No vendors available');
    });

    it('an empty answer says there are none, with a real plural', async () => {
        answer(200, { rows: [] });
        render(<EntityPicker tenantSlug="acme" entityType="POLICY" value="" onChange={jest.fn()} />);
        await waitFor(() => expect(trigger().textContent).toContain('No policies available'));
        expect(trigger().textContent).not.toContain('policys');
    });

    it('names the kind in Bulgarian', async () => {
        mockCatalogue.messages = BG;
        answer(200, { rows: [] });
        render(<EntityPicker tenantSlug="acme" entityType="AUDIT_PACK" value="" onChange={jest.fn()} />);
        const expected = BG.common.ui.noEntitiesAvailable.replace('{entity}', BG.common.ui.entityPlural.AUDIT_PACK);
        await waitFor(() => expect(trigger().textContent).toContain(expected));
        expect(trigger().textContent).not.toMatch(/audit pack/i);
    });
});
