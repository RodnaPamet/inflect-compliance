/**
 * The bottom-right corner has exactly one resident, and anything else there
 * outranks it.
 *
 * ═══ WHY THIS EXISTS ═══
 *
 * #3836 is titled "Confirm the bottom-right corner stays free, and keep it
 * asserted", and its Done-when says "this remains asserted". Only half shipped:
 * `assistant-launcher.test.tsx` asserts the launcher itself carries
 * `bottom-0 right-0`, and nothing asserted the corner was free of anything ELSE.
 * The three facts the issue checked — toasts top-right, mobile nav a drawer, no
 * fixed bottom-anchored element in `src/components/layout` — were a point-in-time
 * re-verification written in prose (#3917).
 *
 * An absence is the claim that rots most quietly. A cookie banner, a support
 * widget or a floating action button added later would sit on the launcher with
 * nothing failing, and the diff that did it would look unrelated to the
 * assistant.
 *
 * ═══ THE INVARIANT IS NOT "NOTHING ELSE IS DOWN THERE" ═══
 *
 * Writing it that way would have been wrong, and measuring it is what showed me
 * so. `src/components/ui/popover.tsx` ALREADY has a fixed bottom-anchored
 * element: the mobile drawer variant, a full-width bottom sheet. #3836's prose
 * missed it because it looked only in `src/components/layout`.
 *
 * That element is not a defect. It is transient and it sits at `z-50`, above the
 * launcher's `z-30`, so it COVERS the launcher the same way a Sheet overlay does
 * — which `assistant-launcher.test.tsx` asserts is the correct relationship.
 *
 * So the real invariant is two-part:
 *   1. The set of fixed bottom-anchored elements is known and small; a new one
 *      forces a decision here rather than appearing silently.
 *   2. The launcher is the LOWEST of them, so every other resident covers it
 *      rather than fighting it for the same pixels.
 *
 * Part 2 is the one with teeth: lowering the popover drawer below `z-30`, or
 * raising the launcher above it, would put two elements in one corner at the
 * same depth, and that is the collision the issue was about.
 */
import * as fs from 'fs';
import * as path from 'path';

import { codeOf } from '../helpers/source-blocks';

/*
    THREE ROOTS, because `src/components` is only part of the component tree.

    `src/components/ui/button.tsx` is a re-export shim whose own docblock says
    the implementation moved to `@inflect/ui/components/ui/button` and that "a
    guard that reads this path for CONTENT would read the re-export and pass on
    nothing". The migration (#3046 batch 3a) is partial — `popover.tsx` still
    holds real content here while `button.tsx` does not — so a guard scanning
    `src/` alone would be blind to anything added in the package, and this
    guard's NAME claims the whole product's corner.

    `packages/ui/src` currently contributes 355 files and zero residents. That
    is the point: the cost of covering it is nothing, and the alternative is a
    guard whose reach is narrower than the invariant it is named for.
*/
const ROOTS = ['src/components', 'src/app', 'packages/ui/src'];
const REPO = path.resolve(__dirname, '../..');

/**
 * Known residents, each with the reason it is allowed to anchor to the bottom.
 *
 * A new entry is a decision, not a formality: say why the element belongs in a
 * corner the launcher occupies, and what its z-order relationship to the
 * launcher is.
 */
const ALLOWED: Readonly<Record<string, string>> = {
    'src/components/assistant/AssistantLauncher.tsx':
        'the launcher itself — the corner is its home (#3836), at z-30, which is ' +
        'deliberately the lowest of the residents so every overlay covers it',
    'src/components/ui/popover.tsx':
        'the MOBILE drawer variant: a full-width bottom sheet at z-50. Transient, ' +
        'and above the launcher, so it covers rather than collides — the same ' +
        'relationship assistant-launcher.test.tsx asserts against a Sheet overlay',
};

export interface BottomAnchored {
    readonly file: string;
    readonly className: string;
    readonly z: number | null;
}

/*
    READ THROUGH `codeOf`, NOT A HAND-ROLLED STRIPPER.

    `tests/guardrails/raw-source-assertion-ratchet.test.ts` (Class A) caps the
    number of test files that assert against RAW source text, and it caught the
    first version of this guard. Its reasoning applies here directly: a guard
    that matches text cannot tell a live `className` from one inside a comment,
    so it can be satisfied by prose or reddened by it.

    `codeOf` blanks comments while KEEPING string literals and preserving
    offsets — which this guard needs, because the thing it matches on IS a
    string literal. A stripper that masked those would silently empty every
    assertion below.
*/

/** The numeric depth a Tailwind `z-N` or `z-[N]` class encodes. */
export function zOf(className: string): number | null {
    const bracket = /\bz-\[(\d+)\]/.exec(className);
    if (bracket !== null) return Number(bracket[1]);
    const plain = /\bz-(\d+)\b/.exec(className);
    return plain === null ? null : Number(plain[1]);
}

/**
 * Every `className` string that pins an element and anchors it to the bottom.
 *
 * Requires BOTH `fixed` and a `bottom-*` class in the same string, which is why
 * `before:absolute before:bottom-0` on the nav bar's gradient hairline does not
 * match — it is positioned absolutely, within its own parent, and occupies no
 * corner.
 */
export function bottomAnchoredIn(file: string, source: string): BottomAnchored[] {
    const out: BottomAnchored[] = [];
    const code = codeOf(source);
    for (const m of code.matchAll(/className="([^"]*)"/g)) {
        const cls = m[1];
        if (!/\bfixed\b/.test(cls)) continue;
        if (!/\bbottom-[a-zA-Z0-9.[\]-]+/.test(cls)) continue;
        out.push({ file, className: cls, z: zOf(cls) });
    }
    return out;
}

/** Residents the allowlist does not name. The pure comparison. */
export function unlistedResidents(
    found: readonly BottomAnchored[],
    allowed: Readonly<Record<string, string>>,
): string[] {
    return found.filter((f) => allowed[f.file] === undefined).map((f) => `${f.file} :: ${f.className}`);
}

function tsxFiles(dir: string): string[] {
    const abs = path.join(REPO, dir);
    if (!fs.existsSync(abs)) return [];
    const out: string[] = [];
    const walk = (d: string): void => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith('.tsx')) out.push(path.relative(REPO, full));
        }
    };
    walk(abs);
    return out;
}

const FOUND: BottomAnchored[] = ROOTS.flatMap((root) =>
    tsxFiles(root).flatMap((f) => bottomAnchoredIn(f, fs.readFileSync(path.join(REPO, f), 'utf8'))),
);

describe('the bottom-right corner has one resident', () => {
    it('scanned a real population (the sweep is not vacuous)', () => {
        // The denominator. A pattern that silently matched nothing would make
        // every assertion below pass forever — and it nearly did: the first
        // measurement for this guard used `grep -E` with a quoted pattern,
        // which in ugrep matches NOTHING, and reported zero residents
        // including the launcher.
        const files = ROOTS.flatMap((r) => tsxFiles(r));
        expect(files.length).toBeGreaterThan(900);
        expect(FOUND.length).toBeGreaterThanOrEqual(2);
    });

    it('every fixed bottom-anchored element is a known resident', () => {
        expect(unlistedResidents(FOUND, ALLOWED)).toEqual([]);
    });

    it('the launcher is the LOWEST resident, so the others cover it', () => {
        const launcher = FOUND.find((f) => f.file.endsWith('AssistantLauncher.tsx'));
        expect(launcher).toBeDefined();
        expect(launcher!.z).toBe(30);

        // Part 2 of the invariant, and the half with teeth: two residents at the
        // same depth in one corner is the collision #3836 was about.
        for (const other of FOUND.filter((f) => f !== launcher)) {
            expect(other.z).not.toBeNull();
            expect(other.z!).toBeGreaterThan(launcher!.z!);
        }
    });

    it('toasts stay out of the corner', () => {
        // The first of #3836's three prose facts, encoded. Moving the Toaster to
        // a bottom position would put countdown bars under the launcher.
        const providers = codeOf(
            fs.readFileSync(path.join(REPO, 'src/app/providers.tsx'), 'utf8'),
        );
        expect(providers).toContain('position="top-right"');
    });
});

describe('the comparison can fail, in both directions', () => {
    const launcher: BottomAnchored = {
        file: 'src/components/assistant/AssistantLauncher.tsx',
        className: 'fixed bottom-0 right-0 z-30 p-4',
        z: 30,
    };

    it('names an element the allowlist does not cover', () => {
        const intruder: BottomAnchored = {
            file: 'src/components/ui/cookie-banner.tsx',
            className: 'fixed bottom-4 right-4 z-20',
            z: 20,
        };
        expect(unlistedResidents([launcher, intruder], ALLOWED)).toEqual([
            'src/components/ui/cookie-banner.tsx :: fixed bottom-4 right-4 z-20',
        ]);
    });

    it('is empty when every element is allowlisted', () => {
        expect(unlistedResidents([launcher], ALLOWED)).toEqual([]);
    });

    it('finds a fixed bottom element in source, and ignores an absolute one', () => {
        expect(bottomAnchoredIn('f.tsx', '<div className="fixed bottom-0 right-0 z-30" />')).toHaveLength(1);
        // The nav bar's gradient hairline: absolute, inside its own parent.
        expect(
            bottomAnchoredIn('f.tsx', '<div className="before:absolute before:bottom-0" />'),
        ).toHaveLength(0);
        // `fixed` without a bottom anchor is a different element entirely.
        expect(bottomAnchoredIn('f.tsx', '<div className="fixed inset-0 z-50" />')).toHaveLength(0);
    });

    it('ignores a mention inside a comment', () => {
        expect(
            bottomAnchoredIn('f.tsx', '// className="fixed bottom-0 right-0"\nconst x = 1;'),
        ).toHaveLength(0);
    });

    it('reads both z-N and z-[N]', () => {
        expect(zOf('fixed bottom-0 z-30')).toBe(30);
        expect(zOf('fixed bottom-0 z-[100]')).toBe(100);
        expect(zOf('fixed bottom-0')).toBeNull();
    });
});
