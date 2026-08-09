/**
 * A `'use client'` file may not VALUE-import from `@/app-layer/usecases/*`.
 *
 * The usecase layer is server-side by definition — it calls repositories,
 * which reach Prisma. A value import from a client component pulls that
 * module, and whatever it transitively imports, into the browser bundle.
 *
 * The two offenders this rule was written for both imported `resolveALE`
 * from `fair-calculator`, and both "worked": that module happens to be
 * pure arithmetic. But it lives beside `risk-dashboard.ts`, which imports
 * `listRisks` and reaches repositories. Nothing structural stopped the
 * next edit to `fair-calculator` from importing a sibling and dragging
 * `@/lib/prisma` into a page bundle. The maths now lives in
 * `@/lib/fair-math`, and this stops the pattern returning.
 *
 * TYPE-ONLY IMPORTS ARE FINE and deliberately allowed. `import type { X }`
 * is erased entirely at compile time — no runtime edge, no bundle weight.
 * Ten client files legitimately import DTO types this way (the org
 * widgets, the dashboard payloads, the readiness result). Banning those
 * would force a pointless duplication of every server DTO shape.
 *
 * WHY A SOURCE SCAN. "No file in this directory may import from that one"
 * is a whole-tree claim about code that may not exist yet. A bundle-size
 * assertion would catch the symptom late and blame the wrong line; this
 * names the file and the import.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const SCAN_DIRS = ['src/app', 'src/components'];

/**
 * Client files permitted a value import, each with the reason. Empty, and
 * meant to stay that way: a client component needing server logic is a
 * signal the logic belongs in `src/lib/`, not that it needs an exemption.
 */
const ALLOWED: Record<string, string> = {};

function walk(dir: string): string[] {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) return [];
    const out: string[] = [];
    const rec = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, e.name);
            if (e.isDirectory()) rec(full);
            else if (/\.(tsx|ts)$/.test(e.name)) out.push(full);
        }
    };
    rec(abs);
    return out;
}

/**
 * The directive must be the first STATEMENT, but comments may precede it.
 * Strip leading comments rather than sampling the first few lines — an
 * early-lines heuristic under-detects exactly the long files most likely
 * to have accumulated a stray import.
 */
function isClientComponent(src: string): boolean {
    const head = src
        .replace(/^﻿/, '')
        .replace(/^(?:\s*(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*)\s*)*/, '');
    return /^['"]use client['"]/.test(head.trimStart());
}

/** Import statements that bring a VALUE (not just a type) into scope. */
function valueImportsOfUsecases(src: string): string[] {
    const hits: string[] = [];
    // `import ... from '@/app-layer/usecases/...'` across newlines, minus
    // the `import type` form and inline `{ type X }` specifiers.
    // The clause must not span another `import` — a naive `[\s\S]*?` starts
    // at an EARLIER import statement and runs to this one's `from`, so a
    // preceding value import makes the following `import type` look like a
    // value import. That mis-flagged ten legitimate DTO imports on the
    // first run of this guard.
    const re = /import\s+(type\s+)?((?:(?!\bimport\b)[\s\S])*?)from\s+['"]@\/app-layer\/usecases\/([^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
        if (m[1]) continue; // `import type { … }` — erased at compile time
        const clause = m[2];
        // `import { type A, type B } from …` is also fully erased.
        const specifiers = clause.replace(/[{}]/g, '').split(',').map((s) => s.trim()).filter(Boolean);
        const hasValue = specifiers.some((s) => s.length > 0 && !/^type\s/.test(s));
        if (hasValue) hits.push(`@/app-layer/usecases/${m[3]}`);
    }
    return hits;
}

describe('client bundles do not reach into the usecase layer', () => {
    it('no `use client` file value-imports from @/app-layer/usecases/*', () => {
        const offenders: string[] = [];

        for (const dir of SCAN_DIRS) {
            for (const abs of walk(dir)) {
                const rel = path.relative(ROOT, abs).split(path.sep).join('/');
                if (rel in ALLOWED) continue;
                const src = fs.readFileSync(abs, 'utf8');
                if (!isClientComponent(src)) continue;
                for (const spec of valueImportsOfUsecases(src)) {
                    offenders.push(`${rel} → ${spec}`);
                }
            }
        }

        expect({
            offenders: offenders.sort(),
            hint:
                offenders.length === 0
                    ? 'none'
                    : 'Move the shared logic to src/lib/ and import it there. A usecase ' +
                      'module reaches repositories, so a value import drags server code — ' +
                      'potentially @/lib/prisma — into the browser bundle. `import type` ' +
                      'is fine; it is erased at compile time.',
        }).toEqual({ offenders: [], hint: 'none' });
    });

    it('type-only imports are still permitted', () => {
        // Guards the guard: if the detector stopped distinguishing `import
        // type`, it would flag ten legitimate DTO imports and the next
        // person would weaken the whole rule to silence them.
        expect(
            valueImportsOfUsecases(
                "import type { PostureSummaryDto } from '@/app-layer/usecases/compliance-posture';",
            ),
        ).toEqual([]);
        expect(
            valueImportsOfUsecases(
                "import { type A, type B } from '@/app-layer/usecases/x';",
            ),
        ).toEqual([]);
        // …and that it still catches the real thing.
        expect(
            valueImportsOfUsecases(
                "import { resolveALE } from '@/app-layer/usecases/fair-calculator';",
            ),
        ).toEqual(['@/app-layer/usecases/fair-calculator']);
        // Mixed clause: one value specifier is enough to flag it.
        expect(
            valueImportsOfUsecases(
                "import { type Foo, resolveALE } from '@/app-layer/usecases/fair-calculator';",
            ),
        ).toHaveLength(1);

        // Regression: a value import on a PRECEDING line must not make the
        // following type-only import look like a value import. The first
        // version of this detector matched across statement boundaries and
        // flagged ten innocent files.
        expect(
            valueImportsOfUsecases(
                [
                    "import { useState } from 'react';",
                    "import type { PostureSummaryDto } from '@/app-layer/usecases/compliance-posture';",
                ].join('\n'),
            ),
        ).toEqual([]);
        // Multi-line type import, which is how most of them are written.
        expect(
            valueImportsOfUsecases(
                "import type {\n    DashboardPayload,\n} from '@/app-layer/usecases/risk-dashboard';",
            ),
        ).toEqual([]);
    });

    it('the allowlist is empty (a client needing server logic means it belongs in src/lib)', () => {
        expect(Object.keys(ALLOWED)).toEqual([]);
    });
});
