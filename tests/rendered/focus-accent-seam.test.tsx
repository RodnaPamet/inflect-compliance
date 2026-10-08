/** @jest-environment jsdom */

/**
 * The shared UI's SOLID focus indicators read the accent — and in Inflect the
 * accent IS the brand, so nothing renders differently.
 *
 * `--accent-default` / `--accent-emphasis` (src/styles/tokens.css) exist for a
 * host that vendors this UI and focuses in a different colour than it fills
 * with: playerz.bg fills with purple and points with yellow. While the Button's
 * halo named `--brand-default`, no token value could give that host a yellow
 * halo without turning every primary button yellow too.
 *
 * Two claims, and this file tests both against the REAL theme blocks (jsdom
 * does not substitute `var()`, so the values are resolved here the way the
 * browser would):
 *
 *   1. THE SEAM — the rendered halo reads `--accent-default`, on the live
 *      button and on the inert `disabledTooltip` shell alike.
 *   2. INFLECT IS UNCHANGED — in both themes the accent is an ALIAS of the
 *      brand (a copied hex would silently stop following a palette change),
 *      and the resolved halo is exactly the brand colour the button painted
 *      before the seam existed.
 *
 * The other consumers (the table and card rings at /40, the tree and graph
 * rings, the undo toast) are held structurally by the lint rule
 * `local/no-brand-focus-indicator`: once none of them may name a brand token,
 * claim 2 covers what they render.
 */
import fs from 'node:fs';
import path from 'node:path';
import { render, screen } from '@testing-library/react';
import * as React from 'react';
import { Button } from '@/components/ui/button';

const TOKENS_CSS = fs.readFileSync(path.join(process.cwd(), 'src/styles/tokens.css'), 'utf8');

/**
 * One theme block → `--token → value`. The block runs from its selector's `{`
 * to the matching `}`; comments are stripped first so a doc block quoting a
 * declaration cannot be read as one.
 */
function themeTokens(selector: string): Record<string, string> {
    const start = TOKENS_CSS.indexOf(`${selector} {`);
    if (start === -1) throw new Error(`theme block ${selector} not found in tokens.css`);
    let depth = 0;
    let i = TOKENS_CSS.indexOf('{', start);
    const bodyStart = i + 1;
    for (; i < TOKENS_CSS.length; i++) {
        if (TOKENS_CSS[i] === '{') depth++;
        else if (TOKENS_CSS[i] === '}' && --depth === 0) break;
    }
    const body = TOKENS_CSS.slice(bodyStart, i).replace(/\/\*[\s\S]*?\*\//g, '');
    const map: Record<string, string> = {};
    for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) map[m[1]] = m[2].trim();
    return map;
}

const THEMES = [
    ['dark (:root)', themeTokens(':root')],
    ['light', themeTokens('[data-theme="light"]')],
] as const;

/** Substitute every `var(--x)` until none is left — what the browser computes. */
function resolve(value: string, tokens: Record<string, string>): string {
    let out = value;
    for (let pass = 0; pass < 10 && out.includes('var('); pass++) {
        out = out.replace(/var\((--[\w-]+)\)/g, (_, name: string) => tokens[name] ?? `__UNRESOLVED(${name})__`);
    }
    return out;
}

/** The `focus-visible:shadow-[…]` value an element renders, with `_` read as a space. */
function focusHalo(el: HTMLElement): string {
    const m = /(?:^|\s)focus-visible:shadow-\[([^\]]+)\]/.exec(el.className);
    if (!m) throw new Error(`no focus-visible:shadow-[…] on: ${el.className}`);
    return m[1].replace(/_/g, ' ');
}

describe('focus accent seam — the halo reads the accent, and the accent is the brand', () => {
    it.each(THEMES)('%s: the accent tokens are ALIASES of the brand', (_theme, tokens) => {
        expect(tokens['--accent-default']).toBe('var(--brand-default)');
        expect(tokens['--accent-emphasis']).toBe('var(--brand-emphasis)');
    });

    it.each(THEMES)('%s: the live Button halo resolves to the brand ring it always painted', (_theme, tokens) => {
        render(<Button>Save</Button>);
        const halo = focusHalo(screen.getByRole('button', { name: 'Save' }));

        // The seam: the outer stop is the accent, not the brand.
        expect(halo).toBe('0 0 0 2px var(--bg-default),0 0 0 4px var(--accent-default)');
        // Unchanged: resolved, it is the surface spacer then the brand colour.
        expect(resolve(halo, tokens)).toBe(
            `0 0 0 2px ${resolve('var(--bg-default)', tokens)},0 0 0 4px ${resolve('var(--brand-default)', tokens)}`,
        );
        expect(resolve(halo, tokens)).not.toContain('__UNRESOLVED');
    });

    it.each(THEMES)('%s: the inert disabledTooltip shell focuses identically', (_theme, tokens) => {
        // button.tsx writes the halo a second time for its cn-only branch;
        // a seam on one copy alone would give a disabled control a
        // different focus colour from a live one.
        render(<Button disabledTooltip="No permission" aria-label="Delete" />);
        const halo = focusHalo(screen.getByRole('button', { name: 'Delete' }));

        expect(halo).toBe('0 0 0 2px var(--bg-default),0 0 0 4px var(--accent-default)');
        expect(resolve(halo, tokens)).toBe(
            `0 0 0 2px ${resolve('var(--bg-default)', tokens)},0 0 0 4px ${resolve('var(--brand-default)', tokens)}`,
        );
    });
});
