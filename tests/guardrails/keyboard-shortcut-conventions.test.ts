/**
 * Epic 57 — static contract checks for the keyboard shortcut system.
 *
 * These are grep-based regression guardrails that fire on every CI
 * run. They exist to keep Epic 57 durable — specifically to prevent:
 *
 *   1. New `document.addEventListener('keydown', …)` or
 *      `window.addEventListener('keydown', …)` listeners sneaking
 *      into application code and competing with the shared registry.
 *
 *   2. New `useKeyboardShortcut()` call sites missing a
 *      `description: '…'` option. Without a description the command
 *      palette renders the shortcut as "(no description)", which is
 *      the wrong signal — every palette-surfaced binding must be
 *      human-readable.
 *
 * The canonical source (the hook itself) is exempt because it owns
 * the one listener the entire system funnels through.
 */

import * as fs from 'fs';
import * as path from 'path';

import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');

/**
 * The document's ATX heading lines AT ONE LEVEL, and nothing else (#2246).
 *
 * NARROWED AT THE READ SEAM RATHER THAN MASKED. The markdown masker
 * `mdCodeOf` keeps the CODE in a document (fences, inline spans) and blanks
 * the prose — and a section heading is prose, so masking would empty the
 * subject: measured on `docs/keyboard-shortcuts.md`, all four needles below
 * match once raw and ZERO times through `mdCodeOf`. The assertion is about
 * the guide's SECTION STRUCTURE, not about code.
 *
 * Narrowing is the other route this repo's Class A advice names, and it is
 * the one that binds here. `/## Scope rules/` against the whole document is
 * satisfied by that text anywhere — a sentence naming the section, a table
 * cell, or a fenced markdown sample. Against the level-2 heading lines only
 * a level-2 heading satisfies it. Fences are tracked and excluded for that
 * last case.
 *
 * `level` is a parameter because the assertions below all write `##`, so
 * that is what they mean — and because `tests/helpers/assertion-reach.ts`
 * tells a narrowing from a mask by ARITY: one argument is the shape of a
 * wrapper and lands in a capped skip bucket, two is the shape of an
 * extraction and is out of scope. See the fuller note in
 * `tests/guardrails/date-picker-guide.test.ts`, where it was measured.
 */
function headingLines(md: string, level: number): string {
    const out: string[] = [];
    const marker = new RegExp(`^#{${level}}\\s`);
    let open: string | null = null;
    for (const line of md.split('\n')) {
        const fence = /^\s*(`{3,}|~{3,})/.exec(line);
        if (fence) {
            if (open === null) open = fence[1][0];
            else if (fence[1][0] === open) open = null;
            continue;
        }
        if (open === null && marker.test(line)) out.push(line);
    }
    return out.join('\n');
}

/** Files that legitimately install keyboard listeners or define the hook. */
const ALLOWED_KEYDOWN_LISTENER_FILES = new Set<string>([
    // The shared hook is the single place a window listener is installed.
    path.join(SRC, 'lib/hooks/use-keyboard-shortcut.tsx'),
]);

function walk(dir: string, acc: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '.next') continue;
            walk(full, acc);
        } else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
            acc.push(full);
        }
    }
    return acc;
}

const KEYDOWN_LISTENER_RE =
    /\b(?:document|window)\s*\.\s*addEventListener\s*\(\s*['"]keydown['"]/g;

/**
 * Strip line comments (slash-slash) and block comments (slash-star)
 * out of a source string so downstream regex scanning doesn't match
 * text inside JSDoc / inline commentary. Example docblocks
 * legitimately mention `useKeyboardShortcut('?')` as prose, which
 * the naive scanner below would otherwise flag as a description-
 * less real call.
 *
 * The stripper is character-by-character and ignores comment tokens
 * that appear inside a quoted string — a real call site can carry
 * a slash-slash inside a string literal and we don't want to eat
 * the closing quote.
 */
function stripComments(src: string): string {
    const out: string[] = [];
    let i = 0;
    const len = src.length;
    while (i < len) {
        const ch = src[i];
        const next = src[i + 1];
        // Line comment
        if (ch === '/' && next === '/') {
            while (i < len && src[i] !== '\n') i++;
            continue;
        }
        // Block comment
        if (ch === '/' && next === '*') {
            i += 2;
            while (i < len && !(src[i] === '*' && src[i + 1] === '/')) i++;
            i += 2;
            continue;
        }
        // String literals — skip past the closing quote so embedded
        // `//` or `/*` inside strings isn't eaten.
        if (ch === '"' || ch === "'" || ch === '`') {
            const quote = ch;
            out.push(ch);
            i++;
            while (i < len && src[i] !== quote) {
                if (src[i] === '\\') {
                    out.push(src[i]);
                    i++;
                    if (i < len) {
                        out.push(src[i]);
                        i++;
                    }
                    continue;
                }
                out.push(src[i]);
                i++;
            }
            if (i < len) {
                out.push(src[i]);
                i++;
            }
            continue;
        }
        out.push(ch);
        i++;
    }
    return out.join('');
}

/**
 * Matches a `useKeyboardShortcut(...)` invocation and captures the
 * argument list up to the matching close paren (works for nested
 * braces / parens inside the args). Runs on comment-stripped source
 * so JSDoc references to `useKeyboardShortcut('?')` don't register
 * as real call sites.
 */
function findKeyboardShortcutCalls(src: string): string[] {
    const code = stripComments(src);
    const calls: string[] = [];
    const starts: number[] = [];
    const needle = /useKeyboardShortcut\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = needle.exec(code)) !== null) {
        starts.push(m.index + m[0].length);
    }
    for (const start of starts) {
        let depth = 1;
        let i = start;
        while (i < code.length && depth > 0) {
            const ch = code[i];
            if (ch === '(') depth++;
            else if (ch === ')') depth--;
            if (depth === 0) break;
            i++;
        }
        calls.push(code.slice(start, i));
    }
    return calls;
}

describe('Keyboard shortcut conventions', () => {
    const allFiles = walk(SRC);

    it('no raw document/window keydown listeners outside the shared hook', () => {
        const violations: { file: string; snippet: string }[] = [];
        for (const file of allFiles) {
            if (ALLOWED_KEYDOWN_LISTENER_FILES.has(file)) continue;
            // Masked at the READ SEAM (#2246), and this scan is the MIRROR
            // IMAGE of the usual case: a negative guard cannot be made green
            // by prose, it is made RED by it. A migration note recording
            // `// was: document.addEventListener('keydown', …)` installs no
            // listener and must not be reported as one.
            const src = codeOf(fs.readFileSync(file, 'utf-8'));
            const match = src.match(KEYDOWN_LISTENER_RE);
            if (match) {
                for (const snippet of match) {
                    violations.push({
                        file: path.relative(ROOT, file),
                        snippet,
                    });
                }
            }
        }
        if (violations.length > 0) {
            const report = violations
                .map((v) => `  ${v.file} — ${v.snippet}`)
                .join('\n');
            fail(
                `Found ${violations.length} raw keydown listener(s) outside ` +
                    `the shared registry. Use useKeyboardShortcut() from ` +
                    `@/lib/hooks/use-keyboard-shortcut instead:\n${report}`,
            );
        }
    });

    it('every useKeyboardShortcut call site passes a `description`', () => {
        const violations: { file: string; call: string }[] = [];

        for (const file of allFiles) {
            // Skip the hook itself (it defines the API) and the shim
            // that re-exports it — neither has call sites of its own.
            if (
                file.endsWith('lib/hooks/use-keyboard-shortcut.tsx') ||
                file.endsWith('components/ui/hooks/use-keyboard-shortcut.tsx') ||
                file.endsWith('keyboard-shortcut-internals.ts')
            ) {
                continue;
            }

            // Masked at the READ SEAM (#2246): a commented-out call site is
            // not a call site, and `findKeyboardShortcutCalls` scans by
            // offset — `codeOf` blanks in place, so every index still lines
            // up with the file on disk.
            const src = codeOf(fs.readFileSync(file, 'utf-8'));
            if (!src.includes('useKeyboardShortcut(')) continue;

            for (const call of findKeyboardShortcutCalls(src)) {
                if (!/\bdescription\s*:/.test(call)) {
                    // Trim the call for the report.
                    const trimmed = call
                        .replace(/\s+/g, ' ')
                        .slice(0, 160);
                    violations.push({
                        file: path.relative(ROOT, file),
                        call: trimmed,
                    });
                }
            }
        }

        if (violations.length > 0) {
            const report = violations
                .map((v) => `  ${v.file}\n    → ${v.call}`)
                .join('\n');
            fail(
                `Found ${violations.length} useKeyboardShortcut call(s) ` +
                    `missing a description. Every binding must be labelled ` +
                    `so the command palette can surface it:\n${report}`,
            );
        }
    });

    it('the contributor guide ships with the canonical code', () => {
        // If someone renames / deletes the doc, the breadcrumb in the
        // hook JSDoc and the palette README become broken links.
        const docPath = path.join(ROOT, 'docs/keyboard-shortcuts.md');
        expect(fs.existsSync(docPath)).toBe(true);

        const headings = headingLines(fs.readFileSync(docPath, 'utf-8'), 2);
        // Canonical sections the hook + palette rely on.
        expect(headings).toMatch(/## TL;DR/i);
        expect(headings).toMatch(/## Priority tiers/i);
        expect(headings).toMatch(/## Scope rules/i);
        expect(headings).toMatch(/## When NOT to add a shortcut/i);
    });
});
