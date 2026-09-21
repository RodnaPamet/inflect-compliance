/**
 * RQ3-10 — Risk Board page ratchet.
 *
 * Regression classes guarded:
 *
 *   - the page sprouting a parallel orchestrator endpoint (the
 *     board MUST consume the existing /risks/dashboard payload —
 *     two sources of truth would drift);
 *   - the page losing its honest-null empty-state copy (a board
 *     pack with a fabricated 0 is the danger this PR exists to
 *     prevent);
 *   - the page losing one of the five sections (the contract is
 *     position / appetite / contributors / efficiency / hygiene);
 *   - the best-value list growing past 3 (the board view is a
 *     leaderboard, the dashboard list is the longer one).
 */

import * as fs from 'fs';
import * as path from 'path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so a guard can no
// longer be satisfied by a COMMENT naming the thing its assertion is about.
//
// LANGUAGE SPLIT. One seam here carries two things. TypeScript-alikes go
// through `read` and are masked. The JSON fixtures go through `readRaw` and
// are NOT: a JSON read is PARSED as data, never matched as text, so masking it
// would only corrupt the parse — `codeOf` lexes TypeScript and a catalogue is
// not that language.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const readRaw = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');
const read = (rel: string) => codeOf(readRaw(rel));
const page = read('src/app/t/[tenantSlug]/(app)/risks/board/page.tsx');
// Board copy migrated to next-intl (riskManager.board.*); resolve the
// empty-state text against the en catalog rather than the page source.
const enBoard = (JSON.parse(readRaw('messages/en.json')) as {
    riskManager: { board: Record<string, string> };
}).riskManager.board;

describe('RQ3-10 — the board page reuses RQ3-9 + RQ3-8 endpoints', () => {
    test('consumes the orchestrator (no new server endpoint for the same data)', () => {
        expect(page).toMatch(/useTenantSWR<DashboardPayload>\(['"]\/risks\/dashboard['"]\)/);
    });

    test('reads the best-value leaderboard from /controls/best-value with limit=3', () => {
        expect(page).toMatch(/['"]\/controls\/best-value\?limit=3['"]/);
    });
});

describe('RQ3-10 — five sections, no fewer', () => {
    test.each([
        'board-position-card',
        'board-appetite-card',
        'board-top-risks-card',
        'board-best-value-card',
        'board-hygiene-card',
    ])('mounts the %s section', (testid) => {
        expect(page).toMatch(new RegExp(`data-testid="${testid}"`));
    });
});

describe('RQ3-10 — every section carries an honest-null empty state', () => {
    test.each([
        ['Position', 'board-position-empty', 'positionEmpty', /Not quantified yet/],
        ['Appetite', 'board-appetite-empty', 'appetiteEmpty', /Set a portfolio loss ceiling/],
        ['Top contributors', 'board-top-risks-empty', 'topEmpty', /No quantified risks yet/],
        ['Best-value', 'board-best-value-empty', 'bestValueEmpty', /No control yet carries a price/],
    ])('%s has a typed empty-state nudge', (_section, testid, key, copy) => {
        expect(page).toMatch(new RegExp(`data-testid="${testid}"`));
        // copy now lives in the catalog; the page renders the t() key.
        expect(enBoard[key as string]).toMatch(copy as RegExp);
    });

    test('Position never fabricates a zero — the ALE figure is gated on a non-null headline', () => {
        expect(page).toMatch(/headlineAle !== null \? \(/);
    });
});

describe('RQ3-10 — board scale (leaderboard, not register)', () => {
    test('top contributors capped at 5', () => {
        expect(page).toMatch(/\.slice\(0, 5\)/);
    });
});
