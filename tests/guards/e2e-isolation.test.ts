/**
 * E2E cross-test `let` cascade ratchet.
 *
 * The anti-pattern this guard bans:
 *
 *   ```ts
 *   let resourceId: string;           // ← module / describe-scoped `let`
 *
 *   test('A creates it', async () => {
 *       resourceId = await createThing();   // ← ASSIGNED inside one test()
 *   });
 *   test('B uses it', async () => {
 *       await page.goto(`/things/${resourceId}`);  // ← READ inside another test()
 *   });
 *   ```
 *
 * When test A fails, `resourceId` is left undefined and test B —
 * plus every later test that reads it — cascades into failure. The
 * file's serial mode makes this *look* ordered but it is NOT
 * isolation: one broken setup step poisons the rest of the file.
 *
 * The fix landed alongside this guard (PR `chore/e2e-isolation`):
 *   - read-only specs keep the shared seeded tenant;
 *   - mutating specs provision a per-test isolated tenant via the
 *     `isolatedTenant` fixture in `tests/e2e/fixtures.ts`;
 *   - a resource a test needs is created INSIDE that test (or in a
 *     `beforeEach`), or — when the steps are genuinely one
 *     scenario — collapsed into a single `test()` with
 *     `test.step(...)` sub-steps.
 *
 * This ratchet scans every `tests/e2e/*.spec.ts` and FAILS if a
 * top-level mutable binding is written inside one `test()` body and
 * read inside a different `test()` body. `BASELINE` carries any
 * file that legitimately still does this (empty today — the PR
 * cleared every known case); a future regression that re-introduces
 * the pattern fails CI. The list is a downward ratchet: when a file
 * is fixed it must be removed from `BASELINE` in the same diff.
 *
 * Modelled on `tests/guards/no-legacy-peer-deps.test.ts` — pure
 * static analysis, no DB, no Playwright runtime.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const E2E_DIR = path.resolve(__dirname, '..', 'e2e');

/**
 * Files that legitimately still carry a cross-test `let` cascade,
 * each with a written reason. EMPTY — the `chore/e2e-isolation` PR
 * cleared every known case. Adding an entry here is a downward
 * ratchet violation unless paired with a concrete, reviewed reason;
 * removing one when the file is fixed is mandatory.
 */
const BASELINE: ReadonlyArray<{ file: string; reason: string }> = [];

/** All E2E spec files. */
function specFiles(): string[] {
    return fs
        .readdirSync(E2E_DIR)
        .filter((f) => f.endsWith('.spec.ts'))
        .sort();
}

/**
 * Strip line + block comments and string/template literals so the
 * identifier scan never trips on text inside a comment or a string.
 * Crude but sufficient for the structural question being asked.
 */
function stripNoise(src: string): string {
    return src
        // block comments
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        // line comments
        .replace(/\/\/[^\n]*/g, ' ')
        // template literals (keep `${}` interpolations would be ideal,
        // but for this guard treating the whole literal as blank is
        // safe — we only care about top-level `let` identifiers, which
        // never live inside a template literal)
        .replace(/`(?:[^`\\]|\\.)*`/g, '``')
        // double / single quoted strings
        .replace(/"(?:[^"\\]|\\.)*"/g, '""')
        .replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

/**
 * Find the `{ … }` body span for each `test('…', …)` /
 * `test('…', …)` call (also `test.only` / `test.fixme`). Returns an
 * array of `[start, end]` index pairs into `src`. `test.describe`,
 * `test.step`, `beforeEach`, `beforeAll` are intentionally NOT
 * matched — assignment inside a `beforeEach`/`beforeAll` is the
 * CORRECT shared-setup pattern, and `test.step` runs inside its
 * parent `test()` so it shares that test's isolation.
 */
function testBodySpans(src: string): Array<[number, number]> {
    const spans: Array<[number, number]> = [];
    // Match `test(` or `test.only(` / `test.fixme(` — but NOT
    // `test.describe(` / `test.step(` / `test.beforeEach(` etc.
    const callRe = /\btest(?:\.(?:only|fixme|skip))?\s*\(/g;
    // The loop body uses `callRe.lastIndex` (cursor position) rather
    // than the match-result groups, so we don't bind the result.
    while (callRe.exec(src) !== null) {
        // Walk forward to the first `{` that opens the callback body,
        // then brace-match to its close.
        let i = callRe.lastIndex;
        // Find the `=> {` or `function … {` opening brace.
        let depthParen = 1; // we're inside the `test(` paren
        let openBrace = -1;
        for (; i < src.length; i++) {
            const c = src[i];
            if (c === '(') depthParen++;
            else if (c === ')') {
                depthParen--;
                if (depthParen === 0) break; // `test(...)` with no body brace
            } else if (c === '{' && depthParen === 1) {
                openBrace = i;
                break;
            }
        }
        if (openBrace === -1) continue;
        // Brace-match from openBrace.
        let depth = 0;
        let end = -1;
        for (let j = openBrace; j < src.length; j++) {
            const c = src[j];
            if (c === '{') depth++;
            else if (c === '}') {
                depth--;
                if (depth === 0) {
                    end = j;
                    break;
                }
            }
        }
        if (end !== -1) spans.push([openBrace, end]);
    }
    return spans;
}

/**
 * Top-level (module- or describe-scoped) mutable bindings — every
 * `let`/`var` identifier that is NOT declared inside a `test()`
 * body. `const` is excluded: a `const` cannot be reassigned inside
 * a test, so it can never carry a cross-test cascade.
 */
function topLevelMutableBindings(
    src: string,
    spans: Array<[number, number]>,
): string[] {
    const inTest = (idx: number) =>
        spans.some(([s, e]) => idx > s && idx < e);
    const names = new Set<string>();
    const declRe = /\b(?:let|var)\s+([A-Za-z_$][\w$]*)/g;
    let m: RegExpExecArray | null;
    while ((m = declRe.exec(src)) !== null) {
        if (!inTest(m.index)) names.add(m[1]);
    }
    return [...names];
}

/**
 * For a given binding name, does ANY `test()` body ASSIGN it
 * (`name =`, `name +=`, …) and does a DIFFERENT `test()` body READ
 * it? Returns the cascade detail if so.
 */
function detectCascade(
    name: string,
    src: string,
    spans: Array<[number, number]>,
): { assignedIn: number; readIn: number } | null {
    // Word-boundaried identifier occurrences.
    const idRe = new RegExp(`\\b${name}\\b`, 'g');
    // An assignment is `name` followed by `=` that is NOT `==`,
    // `===`, `<=`, `>=`, `!=` and not part of `=>`.
    const assignSpans: number[] = [];
    const readSpans: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = idRe.exec(src)) !== null) {
        const idx = m.index;
        const spanIdx = spans.findIndex(([s, e]) => idx > s && idx < e);
        if (spanIdx === -1) continue; // occurrence outside any test()
        // Look at what follows (skip whitespace).
        let k = idRe.lastIndex;
        while (k < src.length && /\s/.test(src[k])) k++;
        const next = src[k];
        const next2 = src.slice(k, k + 2);
        const isAssign =
            next === '=' &&
            next2 !== '==' &&
            src[k + 1] !== '=' &&
            // not `name =>` (param)
            true;
        const isCompound =
            next2 === '+=' ||
            next2 === '-=' ||
            next2 === '*=' ||
            next2 === '?=';
        if (isAssign || isCompound) {
            assignSpans.push(spanIdx);
        } else {
            readSpans.push(spanIdx);
        }
    }
    if (assignSpans.length === 0 || readSpans.length === 0) return null;
    // Cascade = assigned in one test span, read in a DIFFERENT span.
    for (const a of assignSpans) {
        for (const r of readSpans) {
            if (a !== r) return { assignedIn: a, readIn: r };
        }
    }
    return null;
}

interface Offender {
    file: string;
    binding: string;
}

function scan(): Offender[] {
    const offenders: Offender[] = [];
    for (const file of specFiles()) {
        const raw = fs.readFileSync(path.join(E2E_DIR, file), 'utf8');
        const src = stripNoise(raw);
        const spans = testBodySpans(src);
        if (spans.length < 2) continue; // need ≥2 tests to cascade
        for (const binding of topLevelMutableBindings(src, spans)) {
            if (detectCascade(binding, src, spans)) {
                offenders.push({ file, binding });
            }
        }
    }
    return offenders;
}

describe('E2E test isolation — no cross-test `let` cascade', () => {
    const offenders = scan();

    it('no spec assigns a top-level `let`/`var` in one test and reads it in another', () => {
        const baselineFiles = new Set(BASELINE.map((b) => b.file));
        const unexpected = offenders.filter((o) => !baselineFiles.has(o.file));
        if (unexpected.length > 0) {
            const detail = unexpected
                .map((o) => `  ${o.file}: binding \`${o.binding}\``)
                .join('\n');
            throw new Error(
                `Cross-test \`let\` cascade detected — a resource created in one ` +
                    `test() is read by another, so a failed setup step cascades.\n` +
                    `Fix: create the resource inside the test that needs it (or a ` +
                    `beforeEach), or collapse the sequence into one test() with ` +
                    `test.step(...). See tests/e2e/fixtures.ts.\n${detail}`,
            );
        }
        expect(unexpected).toEqual([]);
    });

    it('BASELINE has no stale entries (every listed file still offends)', () => {
        const offendingFiles = new Set(offenders.map((o) => o.file));
        const stale = BASELINE.filter((b) => !offendingFiles.has(b.file));
        if (stale.length > 0) {
            throw new Error(
                `BASELINE lists files that no longer offend — delete them: ` +
                    stale.map((s) => s.file).join(', '),
            );
        }
        expect(stale).toEqual([]);
    });

    it('the isolation fixture module exists and exports the `isolatedTenant` fixture', () => {
        const fixturesPath = path.join(E2E_DIR, 'fixtures.ts');
        expect(fs.existsSync(fixturesPath)).toBe(true);
        const fixturesSrc = fs.readFileSync(fixturesPath, 'utf8');
        // The fixture must be wired via `base.extend` and expose
        // `isolatedTenant`. These two anchors are load-bearing.
        expect(fixturesSrc).toMatch(/base\.extend</);
        expect(fixturesSrc).toMatch(/isolatedTenant:/);
    });

    // In-file regression proof: the detector must catch the pattern.
    it('regression proof — the detector flags a synthetic cascade', () => {
        const synthetic = `
            import { test, expect } from './fixtures';
            let sharedId = '';
            test('creates', async () => { sharedId = 'abc'; });
            test('reads', async () => { expect(sharedId).toBe('abc'); });
        `;
        const src = stripNoise(synthetic);
        const spans = testBodySpans(src);
        expect(spans.length).toBe(2);
        const bindings = topLevelMutableBindings(src, spans);
        expect(bindings).toContain('sharedId');
        expect(detectCascade('sharedId', src, spans)).not.toBeNull();
    });

    it('regression proof — the detector does NOT flag a self-contained test', () => {
        // A `let` assigned AND read inside the SAME test() is fine —
        // not a cross-test cascade.
        const ok = `
            import { test, expect } from './fixtures';
            test('self-contained', async () => {
                let localId = '';
                localId = 'abc';
                expect(localId).toBe('abc');
            });
            test('also self-contained', async () => {
                let other = 1;
                other = 2;
                expect(other).toBe(2);
            });
        `;
        const src = stripNoise(ok);
        const spans = testBodySpans(src);
        // `localId` / `other` are declared INSIDE test bodies, so they
        // are not top-level bindings at all.
        const bindings = topLevelMutableBindings(src, spans);
        expect(bindings).not.toContain('localId');
        expect(bindings).not.toContain('other');
    });

    it('regression proof — a top-level `let` set in beforeEach is NOT a cascade', () => {
        // Assignment inside beforeEach is the correct shared-setup
        // pattern; the detector only scans `test()` bodies.
        const ok = `
            import { test, expect } from '@playwright/test';
            let slug = '';
            test.beforeEach(async () => { slug = 'acme'; });
            test('a', async () => { expect(slug).toBe('acme'); });
            test('b', async () => { expect(slug).toBe('acme'); });
        `;
        const src = stripNoise(ok);
        const spans = testBodySpans(src);
        // `slug` is read in both test()s but assigned only in
        // beforeEach (outside any test span) → no cascade.
        expect(detectCascade('slug', src, spans)).toBeNull();
    });
});

// ───────────────────────────────────────────────────────────────────
// Shared-seed allowlist — default-isolated invariant (2026-06-23).
//
// The suite runs `fullyParallel: true` (playwright.config.ts). That is
// only safe because every MUTATING spec provisions its own fresh, empty
// tenant via `./fixtures` (`isolatedTenant`/`authedPage`) — two parallel
// tests can never write to the same tenant.
//
// A spec that imports the `test` RUNNER from `@playwright/test` (rather
// than from `./fixtures`) runs against the SHARED seeded tenant. That is
// safe ONLY when the spec is read-only (concurrent reads don't corrupt),
// self-isolating (it builds its own tenant via `createIsolatedTenant`),
// or a known additive mutator pinned `mode: 'serial'` so it can't race
// itself. Every such spec MUST be listed below with a reason.
//
// This is the enforceable form of "a new mutating spec can't sneak onto
// the shared seed": a new spec defaults to `./fixtures` (isolated); if it
// instead imports `@playwright/test` it fails CI here until it is either
// isolated or added to this allowlist with a reviewed reason. (A pure
// "mutating-verb regex" was rejected as the gate — it false-positives on
// read-only specs that click filter/tab buttons, e.g. admin-members opens
// the invite form but never submits it.)
const SHARED_SEED_ALLOWLIST: ReadonlyArray<{ file: string; reason: string }> = [
    // ── Read-only: navigate + assert chrome/role-gates, no DB writes ──
    { file: 'a11y.spec.ts', reason: 'read-only accessibility scan over seeded pages' },
    { file: 'csp-nonce-coverage.spec.ts', reason: 'read-only: loads dashboard + controls and asserts every executable <script> carries a nonce; no DB writes. Replaced tests/guards/csp-nonce-component-scripts-patch.test.ts, a source-scanning ratchet that passed against a stock npm bundle.' },
    { file: 'assets-create-modal.spec.ts', reason: 'read-only: navigates to /assets/new and asserts the create modal opens; never submits the form' },
    { file: 'admin-members.spec.ts', reason: 'read-only: opens the invite form + asserts its fields; never clicks #send-invite-btn' },
    { file: 'admin-regression.spec.ts', reason: 'read-only admin-page regression assertions' },
    { file: 'admin-sso.spec.ts', reason: 'read-only: asserts SSO config UI; no save' },
    { file: 'auth.spec.ts', reason: 'auth/login flows on dedicated users; no shared-seed DATA mutation (rate-limit disabled in E2E)' },
    { file: 'calendar.spec.ts', reason: 'read-only: view/month/category state lives in the query string, so toggling a filter writes to the URL and never to the DB. Needs the shared seed — an empty isolated tenant has no deadlines, so the grid, the count and the filter round-trip would have nothing to assert on' },
    { file: 'credentials-hardening.spec.ts', reason: 'login-throttle/credential hardening on dedicated attempts; no shared-seed data write' },
    { file: 'controls-filter-epic53.spec.ts', reason: 'read-only filter chrome — the FilterSelect command-palette listbox only renders when the controls list has seeded rows; needs the shared seed (empty isolated tenant → no rows → no palette)' },
    { file: 'data-table-platform.spec.ts', reason: 'read-only cross-page table chrome; needs the rich seed (rows on 10 surfaces)' },
    { file: 'filters.spec.ts', reason: 'read-only: FilterToolbar URL-param chrome (static enum-derived options)' },
    { file: 'filter-toolbar-coverage.spec.ts', reason: 'read-only filter-toolbar chrome coverage' },
    { file: 'frameworks.spec.ts', reason: 'read-only: reads the GLOBAL framework catalog; the lone install test idempotent-early-returns on the pre-installed seed' },
    { file: 'page-load-budget.spec.ts', reason: 'read-only navigation-timing budget' },
    { file: 'rbac-access.spec.ts', reason: 'read-only RBAC role-gate navigations' },
    { file: 'tenant-switcher.spec.ts', reason: 'read-only tenant-switcher chrome' },
    { file: 'tooltip-and-copy.spec.ts', reason: 'read-only tooltip + clipboard chrome' },
    // ── Self-isolating: build their own tenant via createIsolatedTenant ──
    { file: 'e2e-utils-isolation.spec.ts', reason: 'exercises the isolation utils themselves; provisions its own tenants' },
    { file: 'onboarding.spec.ts', reason: 'beforeAll createIsolatedTenant + serial wizard flow on its OWN tenant' },
    { file: 'nis2-self-assessment.spec.ts', reason: 'beforeAll createIsolatedTenant per describe + serial NIS2-gated step flow on its OWN tenant' },
    { file: 'ai-gov-self-assessment.spec.ts', reason: 'beforeAll createIsolatedTenant per describe + serial AI-gov-gated step flow on its OWN tenant' },
    { file: 'responsive.spec.ts', reason: 'self-isolating via createIsolatedTenant (per fixtures.ts docstring)' },
    { file: 'theme-toggle.spec.ts', reason: 'self-isolating via createIsolatedTenant (per fixtures.ts docstring)' },
    // ── Known additive shared-seed mutators, pinned mode:serial ──
    // Tracked follow-up: fully isolating these needs new factory infra —
    // risk-seed + framework-install for ai-risk-assessment, org-topology
    // (org + ORG_ADMIN/AUDITOR + child-tenant create) for ciso-portfolio.
    { file: 'ai-risk-assessment.spec.ts', reason: 'applies AI suggestions → writes risks to shared tenant; pinned mode:serial so its own tests never race. Isolate later (risk-seed + framework-install factory)' },
    { file: 'ciso-portfolio.spec.ts', reason: 'creates a child tenant in the seeded org; pinned mode:serial. Isolate later (org-topology factory)' },
    { file: 'org-initiatives.spec.ts', reason: 'seeded acme-org ORG_ADMIN (ciso@acme.com) — org-level surface, serial; no shared-tenant DATA mutation beyond the org\'s own initiatives' },
];

describe('E2E test isolation — shared-seed specs are allowlisted (fullyParallel safety)', () => {
    /** Does the spec import the `test` RUNNER from `@playwright/test`? */
    function importsSharedSeedRunner(src: string): boolean {
        return /import\s*\{[^}]*\btest\b[^}]*\}\s*from\s*['"]@playwright\/test['"]/.test(
            src,
        );
    }

    const sharedSeedSpecs = specFiles().filter((f) =>
        importsSharedSeedRunner(fs.readFileSync(path.join(E2E_DIR, f), 'utf8')),
    );
    const allowed = new Set(SHARED_SEED_ALLOWLIST.map((e) => e.file));

    it('every spec importing the @playwright/test runner is allowlisted (else use ./fixtures)', () => {
        const unlisted = sharedSeedSpecs.filter((f) => !allowed.has(f));
        if (unlisted.length > 0) {
            throw new Error(
                `These specs import the \`test\` runner from @playwright/test (shared ` +
                    `seeded tenant) but are not in SHARED_SEED_ALLOWLIST:\n` +
                    unlisted.map((f) => `  ${f}`).join('\n') +
                    `\n\nThe suite runs fullyParallel. A new spec that MUTATES must import ` +
                    `from './fixtures' (per-test isolated tenant). If the spec is genuinely ` +
                    `read-only / self-isolating / a serial additive mutator, add it to ` +
                    `SHARED_SEED_ALLOWLIST with a reason. See tests/e2e/fixtures.ts.`,
            );
        }
        expect(unlisted).toEqual([]);
    });

    it('SHARED_SEED_ALLOWLIST has no stale entries (every listed file still imports @playwright/test)', () => {
        const stale = SHARED_SEED_ALLOWLIST.filter(
            (e) => !sharedSeedSpecs.includes(e.file),
        );
        if (stale.length > 0) {
            throw new Error(
                `SHARED_SEED_ALLOWLIST lists files that no longer import the ` +
                    `@playwright/test runner (migrated to ./fixtures?) — delete them: ` +
                    stale.map((s) => s.file).join(', '),
            );
        }
        expect(stale).toEqual([]);
    });

    it('the two known shared-seed mutators are pinned mode:serial (no self-race under fullyParallel)', () => {
        for (const f of ['ai-risk-assessment.spec.ts', 'ciso-portfolio.spec.ts']) {
            const src = fs.readFileSync(path.join(E2E_DIR, f), 'utf8');
            expect(src).toMatch(/test\.describe\.configure\(\{\s*mode:\s*'serial'\s*\}\)/);
        }
    });
});
