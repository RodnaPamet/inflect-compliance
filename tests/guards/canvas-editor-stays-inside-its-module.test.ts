/**
 * The canvas editor may only be imported from inside the module it belongs to.
 *
 * ═══ WHY THIS IS A LICENCE CONTROL, NOT A TIDINESS RULE ═══
 *
 * The process canvas is an optional per-tenant module, default off, and the
 * `processes/` layout refuses the route with `notFound()` when it is off. That
 * gate is what keeps the editor away from tenants who do not have the module.
 *
 * It holds for one reason and one reason only: **nothing outside the segment
 * imports the editor.** App Router code-splits by route segment, so the editor
 * ships in the `/processes` chunk and a tenant who never loads that route never
 * downloads it. The moment a component outside the segment imports it, it moves
 * into a shared chunk and every tenant downloads it — with the module still
 * reading "off" everywhere an operator can see.
 *
 * That matters more than a wasted download. The editor is licensed software
 * whose licence turns on whether it is "accessible to end users, customers, or
 * the public", and it carries its own enforcement. A module flag that hides the
 * page while the bundle still ships the SDK to every customer is not the
 * control anybody thinks it is, and the failure is invisible in review: the
 * page is gone and the bundle is not.
 *
 * ═══ WHY A GUARD AND NOT A `dynamic()` WRAPPER ═══
 *
 * Lazily importing the canvas inside the segment does nothing about the actual
 * failure mode, which is a STATIC import from another segment. `dynamic()`
 * defers loading for the importer that uses it; it does not stop a second
 * importer existing. The property worth enforcing is about the import graph,
 * so the check is about the import graph.
 *
 * ═══ THE BOW-TIE CANVAS IS A SEPARATE FEATURE AND IS ALLOWED ═══
 *
 * THREE features in this repo use the same rendering library, not one:
 *
 *   1. the process canvas — the module this guard bounds;
 *   2. the bow-tie risk canvas (`risks/[riskId]/BowTie*.tsx`);
 *   3. the traceability graph explorer (`components/ui/GraphExplorer.tsx`).
 *
 * (2) and (3) are listed as known exceptions rather than silently matched. Two
 * consequences worth knowing before planning a migration: "drop the dependency
 * when zero files import it" is NOT reachable by migrating the process canvas
 * alone, and if a migration ever moves (3) onto a licensed editor it lands in
 * `components/ui` — shared by construction — where no module gate reaches it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

/** The editor libraries whose blast radius this guard bounds. */
const EDITOR_PACKAGES = ['@xyflow/react', 'tldraw', '@tldraw/tldraw'] as const;

/** Where the process canvas module lives. Imports here are expected. */
const MODULE_DIRS = [
    'src/app/t/[tenantSlug]/(app)/processes',
    'src/components/processes',
    'src/lib/processes',
] as const;

/**
 * Known, deliberate importers outside the module.
 *
 * The bow-tie risk canvas is a different product feature that happens to use
 * the same library. Listed explicitly so adding a THIRD out-of-module importer
 * is a review question rather than something a wildcard absorbs.
 */
const ALLOWED_OUTSIDE: readonly string[] = [
    // THE BOW-TIE RISK CANVAS — a different product feature that happens to use
    // the same rendering library. Not the process canvas, not governed by this
    // module, and it must keep working when the module is off.
    'src/app/t/[tenantSlug]/(app)/risks/[riskId]/BowTieCanvas.tsx',
    'src/app/t/[tenantSlug]/(app)/risks/[riskId]/BowTieNode.tsx',
    // THE TRACEABILITY GRAPH EXPLORER — a third feature on the same library,
    // and the one worth watching. It sits in `components/ui`, the shared
    // directory, so it is the likeliest of the three to be pulled into a common
    // chunk by a future importer. It is exempt from the MODULE rule because it
    // is not the process canvas; it is NOT exempt from the reason the rule
    // exists, and if the editor here ever becomes tldraw the licence question
    // returns for this file first.
    'src/components/ui/GraphExplorer.tsx',
];

function walk(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = path.join(dir, e.name);
        if (e.isDirectory()) walk(rel, out);
        else if (/\.tsx?$/.test(e.name)) out.push(rel);
    }
    return out;
}

const insideModule = (rel: string) => MODULE_DIRS.some((d) => rel.startsWith(d));

const importers = walk('src').filter((rel) => {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    return EDITOR_PACKAGES.some((pkg) => src.includes(`from '${pkg}`) || src.includes(`from "${pkg}`));
});

describe('the canvas editor stays inside the module that gates it', () => {
    it('finds the editor at all — the positive control', () => {
        // Without this, a typo in EDITOR_PACKAGES or a walk that returned
        // nothing would make every assertion below pass over an empty set.
        // An empty selection is a pass.
        expect(importers.length).toBeGreaterThan(0);
        expect(importers.some(insideModule)).toBe(true);
    });

    it('no file outside the process module imports the editor, except the known bow-tie canvas', () => {
        const outside = importers.filter((rel) => !insideModule(rel));
        const unexpected = outside.filter((rel) => !ALLOWED_OUTSIDE.includes(rel));

        expect({
            why: 'An importer outside src/{app,components,lib}/**/processes puts the editor in a shared chunk, so every tenant downloads it while the module still reads "off". If this is deliberate, add it to ALLOWED_OUTSIDE with a reason.',
            unexpected,
        }).toEqual({ why: expect.any(String), unexpected: [] });
    });

    it('the allow-list has no dead entries — a stale exemption hides a real one', () => {
        // An exemption for a file that no longer imports the editor would let a
        // future file at the same path import it unchecked.
        const stale = ALLOWED_OUTSIDE.filter((rel) => !importers.includes(rel));
        expect(stale).toEqual([]);
    });
});
