/**
 * Epic 51 — light-mode parity guardrail.
 *
 * Every semantic token that changes between themes must be redefined
 * for the light palette. If a new token lands in `:root` without a
 * matching `[data-theme="light"]` override, the light theme silently
 * falls back to the dark value — a subtle regression that's hard to
 * catch by eye because most surfaces in the app still render
 * correctly.
 *
 * Rule: the `[data-theme="light"]` block must declare every token
 * whose value *changes between themes*. Tokens that are shared across
 * themes (brand colors, radii, shadows pre-override, transitions,
 * focus ring) are excluded by convention — documented inline in
 * `tokens.css`.
 *
 * This guardrail reads the file and enforces the parity list below.
 * When a new theme-dependent token is added, extend THEME_TOKENS.
 */

import * as fs from 'fs';
import * as path from 'path';

import { cssCodeOf } from '../helpers/source-blocks';

const TOKENS_CSS = path.resolve(__dirname, '../../src/styles/tokens.css');

/**
 * Tokens that must have a light-mode override. These are every token
 * that changes palette between dark and light — surfaces, content
 * text, borders, status colors, glass, and shadows.
 *
 * Brand tokens (`--brand-*`), ring / focus (`--ring-*`), radii
 * (`--radius-*`), and durations stay the same across themes and are
 * NOT in this list.
 */
const THEME_TOKENS = [
    // Surfaces
    '--bg-page',
    '--bg-default',
    '--bg-muted',
    '--bg-subtle',
    '--bg-elevated',
    '--bg-inverted',
    '--bg-overlay',
    // Content
    '--content-emphasis',
    '--content-default',
    '--content-muted',
    '--content-subtle',
    '--content-inverted',
    // Borders
    '--border-default',
    '--border-subtle',
    '--border-emphasis',
    // Status
    '--bg-success',
    '--content-success',
    '--border-success',
    '--bg-warning',
    '--content-warning',
    '--border-warning',
    '--bg-error',
    '--content-error',
    '--border-error',
    '--bg-info',
    '--content-info',
    '--border-info',
    '--bg-attention',
    '--content-attention',
    '--border-attention',
    // Glass + shadow (light uses lighter variants)
    '--glass-bg',
    '--glass-border',
    '--shadow-sm',
    '--shadow',
    '--shadow-lg',
    // Ring-offset depends on the page surface
    '--ring-offset-background',
];

function extractBlock(src: string, selector: RegExp): string {
    const match = src.match(selector);
    if (!match) throw new Error(`Cannot find ${selector} block in tokens.css`);
    const start = match.index! + match[0].length;
    const end = src.indexOf('}', start);
    return src.slice(start, end);
}

describe('Epic 51 — light-mode parity', () => {
    // Masked at the READ SEAM (#2246): a token defined only inside a
    // /* … */ comment must not satisfy a parity assertion about it.
    const src = cssCodeOf(fs.readFileSync(TOKENS_CSS, 'utf-8'));
    const rootBlock = extractBlock(src, /:root\s*\{/);
    const lightBlock = extractBlock(src, /\[data-theme="light"\]\s*\{/);

    it('every theme-dependent token has a light-mode override', () => {
        const missing: string[] = [];
        for (const token of THEME_TOKENS) {
            const decl = new RegExp(`${token.replace(/[-/]/g, '\\$&')}\\s*:`, 'm');
            if (!decl.test(lightBlock)) {
                missing.push(token);
            }
        }
        expect(missing).toEqual([]);
    });

    it('every listed theme token actually exists in :root', () => {
        // Catches typos and tokens that were deleted but not removed
        // from the parity list.
        const missing: string[] = [];
        for (const token of THEME_TOKENS) {
            const decl = new RegExp(`${token.replace(/[-/]/g, '\\$&')}\\s*:`, 'm');
            if (!decl.test(rootBlock)) {
                missing.push(token);
            }
        }
        expect(missing).toEqual([]);
    });

    it('light-mode block is declared (feature active, not stubbed)', () => {
        expect(src).toMatch(/\[data-theme="light"\]\s*\{/);
        // The old "NOT shipped" caveat must stay out of the docstring —
        // light mode is a live feature.
        expect(src).not.toMatch(/NOT shipped to the UI/);
    });
});
