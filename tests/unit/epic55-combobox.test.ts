/**
 * Epic 55 Prompt 2 — shared <Combobox> platform contract.
 *
 * Node-env Jest source-inspects the Combobox to lock in the cross-cutting
 * invariants it must satisfy as a drop-in replacement for native
 * `<select>` across the app:
 *
 *   1. Composition — built on `cmdk` (Command/List/Item), inside the
 *      shared Popover (Epic 54), with the ScrollContainer (Epic 55
 *      Prompt 1) in the options panel.
 *   2. Modes — single-select, multi-select, optional async create.
 *   3. Accessibility — `aria-haspopup="listbox"`, `aria-invalid`,
 *      `aria-describedby`, `aria-required`, `aria-selected` on options.
 *   4. Form-field integration — `id`, `name`, `disabled`, `required`,
 *      `invalid` passthrough; hidden input for native `<form onSubmit>`.
 *   5. Keyboard — Escape + Backspace-on-empty close the popover.
 *   6. Loading + empty states render distinctly.
 *   7. Token discipline — no legacy neutral/blue/slate palette.
 */

import * as fs from 'fs';
import * as path from 'path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// String literals are KEPT, so assertions that harvest codes or ids from source
// still see them. Every path this file reads is a TypeScript-alike, re-derived
// per file rather than assumed from the directory.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../../');
function read(rel: string): string {
    return codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf-8'));
}

const SRC = read('src/components/ui/combobox/index.tsx');

// ─── 1. Composition ───────────────────────────────────────────────

describe('Combobox — composition', () => {
    it('is a client component', () => {
        expect(SRC).toMatch(/^"use client"/);
    });

    it('is built on cmdk (Command, Command.Input, Command.List, Command.Item)', () => {
        expect(SRC).toMatch(/from ["']cmdk["']/);
        expect(SRC).toMatch(/<Command\s+loop/);
        expect(SRC).toMatch(/<Command\.Input\b/);
        expect(SRC).toMatch(/<Command\.List\b/);
        expect(SRC).toMatch(/<Command\.Item\b/);
        expect(SRC).toMatch(/<Command\.Loading\b/);
    });

    it('uses the shared Popover primitive (Epic 54)', () => {
        expect(SRC).toMatch(/from ["']\.\.\/popover["']/);
        expect(SRC).toMatch(/<Popover\b/);
    });

    it('uses the shared ScrollContainer for the option list', () => {
        expect(SRC).toMatch(/from ["']\.\.\/scroll-container["']/);
        expect(SRC).toMatch(/<ScrollContainer\b/);
    });
});

// ─── 2. Modes ─────────────────────────────────────────────────────

describe('Combobox — modes', () => {
    it('exposes a `multiple` prop that toggles multi-select semantics', () => {
        expect(SRC).toMatch(/multiple\?:\s*TMultiple/);
        expect(SRC).toMatch(/isMultipleSelection\(/);
    });

    it('has distinct single-vs-multi selected signatures via conditional types', () => {
        expect(SRC).toMatch(
            /selected:\s*TMultiple extends true[\s\S]*?ComboboxOption<TMeta>\[\][\s\S]*?ComboboxOption<TMeta>\s*\|\s*null/,
        );
    });

    it('closes the popover on single-select, stays open on multi-select', () => {
        // Single: setSelected(option) + setIsOpen(false) in handleSelect.
        expect(SRC).toMatch(
            /if \(isMultiple\)[\s\S]*?else[\s\S]*?setIsOpen\(false\)/,
        );
    });

    it('supports async option creation via onCreate + loading spinner', () => {
        expect(SRC).toMatch(/onCreate\?:\s*\(search:\s*string\)\s*=>\s*Promise<boolean>/);
        expect(SRC).toMatch(/setIsCreating\(true\)/);
        expect(SRC).toMatch(/await\s+onCreate\?\.\(search\)/);
        expect(SRC).toMatch(/isCreating\s*\?\s*\(?\s*<LoadingSpinner/);
    });

    it('places the create option inline for multi-select and sticky for single-select', () => {
        // Multi: chained && with search.length > 0 and createOptionItem.
        expect(SRC).toMatch(
            /onCreate\s*&&[\s\S]{0,120}multiple\s*&&[\s\S]{0,120}search\.length\s*>\s*0[\s\S]{0,120}createOptionItem/,
        );
        // Single: sticky footer with border-t.
        expect(SRC).toMatch(
            /onCreate\s*&&\s*!multiple\s*&&\s*\([\s\S]{0,600}border-t[\s\S]{0,600}createOptionItem/,
        );
    });

    it('honours maxSelected — skips selecting beyond the cap', () => {
        expect(SRC).toMatch(/maxSelected\?:\s*number/);
        expect(SRC).toMatch(
            /!isAlreadySelected\s*&&\s*maxSelected\s*&&\s*selected\.length\s*>=\s*maxSelected/,
        );
    });

    it('exposes a `loading` prop that renders the spinner panel', () => {
        expect(SRC).toMatch(/loading\?:\s*boolean/);
        expect(SRC).toMatch(/loading\s*=\s*false/);
        expect(SRC).toMatch(/showLoading\s*=\s*loading\s*\|\|\s*sortedOptions\s*===\s*undefined/);
        expect(SRC).toMatch(/data-combobox-loading/);
    });
});

// ─── 3. Accessibility ─────────────────────────────────────────────

describe('Combobox — accessibility', () => {
    it('marks the trigger with aria-haspopup="listbox"', () => {
        expect(SRC).toMatch(/"aria-haspopup":\s*"listbox"/);
    });

    it('forwards aria-invalid / data-invalid to the trigger', () => {
        expect(SRC).toMatch(/"aria-invalid":\s*effectiveInvalid/);
        expect(SRC).toMatch(/"data-invalid":\s*effectiveInvalid/);
    });

    it('forwards aria-describedby for FormField-driven error chains', () => {
        // Quoted property key in the type literal.
        expect(SRC).toMatch(/["']aria-describedby["']\?:\s*string/);
        expect(SRC).toMatch(/["']aria-describedby["']:\s*ariaDescribedBy/);
    });

    it('sets aria-required when required or aria-required is set', () => {
        expect(SRC).toMatch(
            /"aria-required":\s*required\s*\|\|\s*ariaRequired\s*\|\|\s*undefined/,
        );
    });

    it('sets aria-selected on each Command.Item', () => {
        expect(SRC).toMatch(/aria-selected=\{selected\}/);
    });

    it('closes on Escape and on Backspace-at-empty-search', () => {
        expect(SRC).toMatch(
            /e\.key\s*===\s*["']Escape["']\s*\|\|[\s\S]{0,80}e\.key\s*===\s*["']Backspace["']\s*&&\s*!search/,
        );
        expect(SRC).toMatch(/setIsOpen\(false\)/);
    });
});

// ─── 4. Form-field integration ────────────────────────────────────

describe('Combobox — form-field integration', () => {
    it('exposes id / name / disabled / required / invalid passthrough props', () => {
        expect(SRC).toMatch(/id\?:\s*string/);
        expect(SRC).toMatch(/name\?:\s*string/);
        expect(SRC).toMatch(/disabled\?:\s*boolean/);
        expect(SRC).toMatch(/required\?:\s*boolean/);
        expect(SRC).toMatch(/invalid\?:\s*boolean/);
    });

    it('injects a hidden form input when `name` is supplied', () => {
        expect(SRC).toMatch(
            /hiddenInput\s*=\s*name\s*\?\s*\(\s*<input\s+type="hidden"\s+name=\{name\}\s+value=\{hiddenInputValue\}/,
        );
    });

    it('serialises multi-select values as comma-separated string', () => {
        expect(SRC).toMatch(
            /isMultiple\s*\?\s*selected\.map\(\(o\)\s*=>\s*o\.value\)\.join\(","\)/,
        );
    });

    it('clones props onto caller-provided custom triggers', () => {
        expect(SRC).toMatch(/cloneElement\(/);
    });

    it('paints invalid state on the default trigger via error-border tokens', () => {
        expect(SRC).toMatch(
            /effectiveInvalid\s*&&[\s\S]{0,120}border-border-error/,
        );
    });
});

// ─── 5. Keyboard + internal state ─────────────────────────────────

describe('Combobox — internal state', () => {
    it('resets search + re-sorts when the popover closes', () => {
        expect(SRC).toMatch(
            /if \(isOpen\) return;[\s\S]{0,120}setSearch\(""\)[\s\S]{0,120}setShouldSortOptions\(true\)/,
        );
    });

    it('pins `first: true` options to the top of the unfiltered list', () => {
        expect(SRC).toMatch(/first\?:\s*boolean/);
        expect(SRC).toMatch(
            /opts\.filter\([\s\S]{0,80}o\.first[\s\S]{0,80}!selected\.some/,
        );
    });

    it('supports controlled open via `open` + `onOpenChange`', () => {
        expect(SRC).toMatch(/open\?:\s*boolean/);
        expect(SRC).toMatch(/onOpenChange\?:\s*\(open:\s*boolean\)\s*=>\s*void/);
        expect(SRC).toMatch(/isOpen\s*=\s*open\s*\?\?\s*isOpenInternal/);
    });

    it('surfaces search changes via `onSearchChange` callback', () => {
        expect(SRC).toMatch(/onSearchChange\?:\s*\(search:\s*string\)\s*=>\s*void/);
        expect(SRC).toMatch(/onSearchChange\?\.\(search\)/);
    });
});

// ─── 6. States ────────────────────────────────────────────────────

describe('Combobox — states', () => {
    it('renders a no-matches empty state (customisable via emptyState prop)', () => {
        expect(SRC).toMatch(/emptyState\?:\s*ReactNode/);
        // Default string lives in the shared messages module now.
        expect(SRC).toMatch(/COMBOBOX_DEFAULT_MESSAGES\.emptyState/);
    });

    it('loading spinner renders inside Command.Loading', () => {
        expect(SRC).toMatch(
            /<Command\.Loading>[\s\S]{0,500}<LoadingSpinner/,
        );
    });

    it('honours disabledTooltip per option (wraps in Tooltip)', () => {
        expect(SRC).toMatch(/disabledTooltip\?:\s*ReactNode/);
        expect(SRC).toMatch(/<Tooltip content=\{disabledTooltip\}>/);
    });
});

// ─── 7. Token discipline ──────────────────────────────────────────

describe('Combobox — token discipline', () => {
    it('uses only semantic tokens in className strings', () => {
        const classStrings = SRC.match(/["'][^"'\n]*["']/g) ?? [];
        for (const cls of classStrings) {
            // Skip non-class strings (props, keys, values) by only
            // checking strings that look like Tailwind class bundles.
            if (!/\b(bg|text|border|ring|from|to)-/.test(cls)) continue;
            expect(cls).not.toMatch(/\bbg-neutral-\d/);
            expect(cls).not.toMatch(/\btext-neutral-\d/);
            expect(cls).not.toMatch(/\bbg-blue-\d/);
            expect(cls).not.toMatch(/\btext-blue-\d/);
            expect(cls).not.toMatch(/\bbg-slate-\d/);
            expect(cls).not.toMatch(/\btext-slate-\d/);
            expect(cls).not.toMatch(/\bbg-white\b/);
        }
    });
});

// ─── 8. Exports ───────────────────────────────────────────────────

describe('Combobox — exports', () => {
    it('exports Combobox, ComboboxOption, ComboboxProps', () => {
        expect(SRC).toMatch(/export\s+function\s+Combobox</);
        expect(SRC).toMatch(/export\s+type\s+ComboboxOption/);
        expect(SRC).toMatch(/export\s+type\s+ComboboxProps/);
    });

    it('declares Combobox as generic over <TMultiple, TMeta>', () => {
        expect(SRC).toMatch(
            /Combobox<\s*TMultiple[\s\S]{0,60}TMeta[\s\S]{0,80}>\(/,
        );
    });
});
