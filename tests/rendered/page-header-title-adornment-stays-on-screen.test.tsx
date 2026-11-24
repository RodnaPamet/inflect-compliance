/**
 * The page header's title row keeps its adornment (the record pager) on screen.
 *
 * The title and the prev/next pager share one flex row. The heading could not
 * shrink below its longest word, so a title on one long word pushed the pager
 * past the right edge of a phone, where the shell's `overflow-x-clip` cut it
 * off: "next" at 390 px, both buttons at 360 on a policy.
 *
 * jsdom does no layout, so this holds the classes that make the row fit: the
 * heading shrinks (`min-w-0`) and breaks an over-long word, the adornment
 * never shrinks, and nothing GROWS — so on a wide screen the pager still sits
 * right beside the title rather than at the far end of the row. The second
 * half compiles the real stylesheet to prove the wrapping class is a rule.
 */
import { execFileSync } from 'child_process';
import * as path from 'path';
import * as React from 'react';
import { render, screen } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    usePathname: () => '/t/acme/policies/p1',
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    useParams: () => ({ tenantSlug: 'acme' }),
    useSearchParams: () => new URLSearchParams(),
}));

import { PageHeader } from '@/components/layout/PageHeader';

const ONE_LONG_WORD = 'Информационнасигурностиуправлениенадостъпаинепрекъснатост';

function classesOf(el: Element): string[] {
    return el.className.split(/\s+/).filter(Boolean);
}

function renderHeader() {
    render(
        <PageHeader
            back={{ smart: true }}
            title={ONE_LONG_WORD}
            titleAdornment={
                <nav aria-label="Pager" data-testid="pager">
                    <button type="button">Previous policy</button>
                    <button type="button">Next policy</button>
                </nav>
            }
        />,
    );
}

describe('a long one-word title beside the record pager', () => {
    it('lets the heading shrink and break the word', () => {
        renderHeader();
        const heading = screen.getByTestId('page-header-title');
        expect(heading.textContent).toBe(ONE_LONG_WORD);
        expect(classesOf(heading)).toEqual(expect.arrayContaining(['min-w-0', 'wrap-break-word']));
        // Growing would move the pager to the far end of the row on desktop.
        expect(classesOf(heading)).not.toContain('flex-1');
    });

    it('keeps the pager out of the heading, in a box that does not shrink', () => {
        renderHeader();
        const heading = screen.getByTestId('page-header-title');
        const pager = screen.getByTestId('pager');
        expect(heading).not.toContainElement(pager);
        const box = screen.getByTestId('page-header-title-adornment');
        expect(box).toContainElement(pager);
        expect(classesOf(box)).toContain('shrink-0');
    });

    it('puts heading and pager in one row that does not wrap the pager away', () => {
        renderHeader();
        const row = screen.getByTestId('page-header-title-row');
        expect(row).toContainElement(screen.getByTestId('page-header-title'));
        expect(row).toContainElement(screen.getByTestId('page-header-title-adornment'));
        expect(classesOf(row)).toContain('flex');
    });
});

describe('the wrapping class becomes a rule', () => {
    let css = '';
    beforeAll(() => {
        css = execFileSync(
            process.execPath,
            [path.join(__dirname, '../helpers/compile-globals-css.mjs')],
            { cwd: path.join(__dirname, '../..'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
        );
    }, 180_000);

    it('compiles to something substantial (floor on the collector)', () => {
        expect(css.length).toBeGreaterThan(50_000);
    });

    it('emits the heading utility that breaks an over-long word', () => {
        expect(css).toMatch(/\.wrap-break-word\s*\{\s*overflow-wrap:\s*break-word;?\s*\}/);
    });
});
