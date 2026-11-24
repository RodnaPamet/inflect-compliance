/**
 * A policy template's title and category are shown in the template's own
 * language, and marked as such (#5924).
 *
 * The template library is English (owner decision 2026-11-23: library content
 * is content, not interface text). On a Bulgarian page its categories —
 * "Technical", "Cryptography", "Operations" — read as English interface labels
 * that missed the catalog, to a screen reader and to the phone audit alike.
 * Each tile now carries the template's `lang`, the library's English when the
 * template states none; the dialog's own words carry none.
 */
import { render, screen } from '@testing-library/react';

jest.mock('next/dynamic', () => () => () => null);

import { NewPolicyFields } from '@/app/t/[tenantSlug]/(app)/policies/_form/NewPolicyFields';
import type { NewPolicyFormReturn } from '@/app/t/[tenantSlug]/(app)/policies/_form/useNewPolicyForm';

function formWith(templates: Array<Record<string, unknown>>): NewPolicyFormReturn {
    return {
        isTemplateMode: true,
        templatesStatus: 'ready',
        templatesError: null,
        templates,
        fields: { title: '', description: '', category: '', content: '', contentType: 'HTML', templateId: '' },
        selectTemplate: jest.fn(),
        setField: jest.fn(),
    } as unknown as NewPolicyFormReturn;
}

describe('policy template tiles', () => {
    it('mark the title and category with the template’s language, the library’s English by default', () => {
        render(
            <NewPolicyFields
                form={formWith([
                    { id: 'tpl-1', title: 'Cryptography Policy', category: 'Cryptography', language: 'en' },
                    { id: 'tpl-2', title: 'Endpoint Security Policy', category: 'Technical', language: null },
                    { id: 'tpl-3', title: 'Политика за пароли', category: 'Сигурност', language: 'bg' },
                ])}
            />,
        );
        const langOf = (text: string) => screen.getByText(text).closest('[lang]')?.getAttribute('lang');
        expect(langOf('Cryptography Policy')).toBe('en');
        expect(langOf('Cryptography')).toBe('en');
        expect(langOf('Technical')).toBe('en');
        expect(langOf('Endpoint Security Policy')).toBe('en');
        expect(langOf('Политика за пароли')).toBe('bg');
        expect(langOf('Сигурност')).toBe('bg');
    });

    it('keep each tile a button whose content is phrasing content', () => {
        render(<NewPolicyFields form={formWith([{ id: 'tpl-1', title: 'Cryptography Policy', category: 'Cryptography' }])} />);
        const tile = screen.getByText('Cryptography Policy').closest('button');
        expect(tile).not.toBeNull();
        // A <p> inside a <button> is invalid HTML; the tile uses spans.
        expect(tile?.querySelector('p')).toBeNull();
    });
});
