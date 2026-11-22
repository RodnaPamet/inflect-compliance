/**
 * Epic 55 `<Textarea>`: what `aria-describedby` names must exist (#5054 review).
 *
 * The description gives way to the error. It used to keep its id in
 * `aria-describedby` while it was not rendered, so a field with both a
 * description and an error was described by an element that did not exist.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';

import { Textarea } from '@/components/ui/textarea';

const describedBy = () =>
    (screen.getByRole('textbox').getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);

describe('Textarea aria-describedby', () => {
    it('names the description while it is shown', () => {
        render(<Textarea id="f" aria-label="field" description="A hint" />);
        expect(describedBy()).toEqual(['f-description']);
        expect(document.getElementById('f-description')?.textContent).toBe('A hint');
    });

    it('names only the error once the error replaces the description', () => {
        render(<Textarea id="f" aria-label="field" description="A hint" error="Too long" />);
        expect(document.getElementById('f-description')).toBeNull();
        expect(describedBy()).toEqual(['f-error']);
        for (const id of describedBy()) expect(document.getElementById(id)).not.toBeNull();
    });

    it("keeps the caller's own describedby", () => {
        render(<Textarea id="f" aria-label="field" aria-describedby="outside" error="Too long" />);
        expect(describedBy()).toEqual(['outside', 'f-error']);
    });
});
