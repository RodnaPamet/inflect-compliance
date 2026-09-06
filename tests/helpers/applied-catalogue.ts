/**
 * What the product ACTUALLY applies, as text a guard can ask questions of.
 *
 * ═══ THE MISTAKE THIS REPLACES ═══
 *
 * Guards across this suite decided whether a framework, pack, policy or
 * template was AVAILABLE by reading `prisma/seed.ts` and looking for a string:
 *
 *     expect(seed).toContain('NIS2_BASELINE');
 *
 * `prisma/seed.ts` is not run on production deploys. So an assertion of that
 * shape cannot fail while the thing it names is undeliverable — and it DOES
 * fail the moment somebody fixes the delivery, because the declaration moves
 * into a CatalogFile. Three such guards went red on the DORA and NIS2
 * migrations, each on the change that made its framework reachable for the
 * first time. The assertion was named for an outcome and bound to an
 * implementation.
 *
 * ═══ WHAT COUNTS AS APPLIED ═══
 *
 * Both paths, distinguished rather than merged:
 *
 *   • `prisma/seed.ts` — applied in dev by `npm run db:seed`. Reaches no
 *     production database. `reachesProduction: false`.
 *   • every fixture named by a seeder that `scripts/entrypoint.sh` runs —
 *     applied on every container start. `reachesProduction: true`.
 *
 * Both are discovered, never listed: the seeders come from the
 * `node dist/<name>.mjs` lines in `entrypoint.sh`, and each seeder's fixtures
 * from its own source. A hand-maintained list here would be one more copy of
 * the thing that rots, and this file exists because copies rot.
 *
 * ═══ WHY IT THROWS ═══
 *
 * The two ad-hoc versions this replaces both read fixtures inside
 * `catch { return '' }`. That is the failure this whole area keeps producing:
 * a rename, a moved directory or a regex that stops matching yields an empty
 * catalogue arm, every caller silently falls back to `seed.ts` alone, and the
 * entire sweep reverts to the weak question with a green build. An unreadable
 * member is a broken scan, not an absent declaration, so it throws.
 *
 * @module tests/helpers/applied-catalogue
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './repo-files';

/** The dev-only seeder. Applied by `npm run db:seed`, never on a deploy. */
const DEV_SEEDER = 'prisma/seed.ts';

const ENTRYPOINT = 'scripts/entrypoint.sh';

/** One source that something actually applies. */
export interface AppliedSource {
    /** Repo-relative path. */
    readonly file: string;
    /** The seeder that names it, or DEV_SEEDER for the dev-only path. */
    readonly appliedBy: string;
    /** True when `appliedBy` runs from entrypoint.sh, i.e. reaches production. */
    readonly reachesProduction: boolean;
    readonly text: string;
}

function read(rel: string): string {
    const abs = path.join(REPO_ROOT, rel);
    try {
        return fs.readFileSync(abs, 'utf8');
    } catch (err) {
        // Deliberately fatal. See the docblock: a silent '' here makes every
        // caller assert against seed.ts alone and pass.
        throw new Error(
            `applied-catalogue: cannot read ${rel} — the scan is broken, not the catalogue. ` +
                `(${(err as Error).message})`,
        );
    }
}

/**
 * Every seeder `scripts/entrypoint.sh` runs, as a repo-relative `.ts` path.
 *
 * The entrypoint invokes bundles (`node dist/seed-x.mjs`); the source that
 * `scripts/build-worker.mjs` bundles is `scripts/seed-x.ts`.
 */
export function productionSeeders(): string[] {
    const entry = read(ENTRYPOINT);
    const names = [...entry.matchAll(/node\s+dist\/([A-Za-z0-9._-]+)\.mjs/g)].map((m) => m[1]);
    return [...new Set(names)]
        .map((n) => `scripts/${n}.ts`)
        .filter((p) => fs.existsSync(path.join(REPO_ROOT, p)));
}

/**
 * `prisma/seed.ts` plus every fixture any production seeder names.
 *
 * Throws if a named fixture cannot be read.
 */
export function appliedSources(): AppliedSource[] {
    const sources: AppliedSource[] = [
        { file: DEV_SEEDER, appliedBy: DEV_SEEDER, reachesProduction: false, text: read(DEV_SEEDER) },
    ];

    const seen = new Set<string>();
    for (const seeder of productionSeeders()) {
        const src = read(seeder);
        sources.push({ file: seeder, appliedBy: seeder, reachesProduction: true, text: src });
        // Both `prisma/fixtures/x.json` and `../prisma/fixtures/x.json` contain
        // the same suffix, so one pattern recovers each spelling.
        for (const m of src.matchAll(/prisma\/fixtures\/([A-Za-z0-9._-]+\.json)/g)) {
            const rel = `prisma/fixtures/${m[1]}`;
            if (seen.has(rel)) continue;
            seen.add(rel);
            sources.push({ file: rel, appliedBy: seeder, reachesProduction: true, text: read(rel) });
        }
    }
    return sources;
}

/**
 * Which applied sources declare `literal`.
 *
 * Quote-agnostic on purpose: the same key is `'SOC2_BASELINE'` in TypeScript
 * and `"SOC2_BASELINE"` in a JSON fixture, and a guard asking "is this pack
 * declared?" does not care which file spells it which way.
 *
 * Returns repo-relative paths. An empty array means nothing applies it.
 */
export function declaringSources(literal: string): string[] {
    return appliedSources()
        .filter((s) => s.text.includes(`'${literal}'`) || s.text.includes(`"${literal}"`))
        .map((s) => s.file);
}

/** As `declaringSources`, restricted to sources that reach production. */
export function productionDeclaringSources(literal: string): string[] {
    return appliedSources()
        .filter((s) => s.reachesProduction)
        .filter((s) => s.text.includes(`'${literal}'`) || s.text.includes(`"${literal}"`))
        .map((s) => s.file);
}

/** The whole applied corpus, for the few callers that need a regex. */
export function appliedCatalogueText(): string {
    return appliedSources()
        .map((s) => s.text)
        .join('\n');
}

/** The parsed CatalogFile a production seeder applies for `frameworkKey`. */
export interface AppliedCatalog {
    readonly file: string;
    readonly framework: Record<string, unknown>;
    readonly requirements: Array<Record<string, unknown>>;
    readonly templates: Array<Record<string, unknown>>;
    readonly pack?: Record<string, unknown>;
}

/**
 * The CatalogFile production applies for a framework, or null if none does.
 *
 * Null is a real answer, not an error: most frameworks are still hand-rolled
 * in `prisma/seed.ts` and have no CatalogFile yet. A caller that needs one
 * should say so with its own assertion rather than have this throw, so the
 * failure names the framework instead of the helper.
 */
export function appliedCatalogFor(frameworkKey: string): AppliedCatalog | null {
    for (const s of appliedSources()) {
        if (!s.reachesProduction || !s.file.endsWith('.json')) continue;
        let doc: unknown;
        try {
            doc = JSON.parse(s.text);
        } catch {
            continue;
        }
        const obj = (doc ?? {}) as {
            framework?: { key?: unknown };
            requirements?: unknown;
            templates?: unknown;
            pack?: unknown;
        };
        if (obj.framework?.key !== frameworkKey) continue;
        return {
            file: s.file,
            framework: obj.framework as Record<string, unknown>,
            requirements: (Array.isArray(obj.requirements) ? obj.requirements : []) as Array<
                Record<string, unknown>
            >,
            templates: (Array.isArray(obj.templates) ? obj.templates : []) as Array<
                Record<string, unknown>
            >,
            pack: obj.pack as Record<string, unknown> | undefined,
        };
    }
    return null;
}

/** Denominator facts, asserted by applied-catalogue-helper.test.ts. */
export function appliedCatalogueStats(): {
    seeders: string[];
    fixtures: string[];
    bytes: number;
} {
    const sources = appliedSources();
    return {
        seeders: productionSeeders(),
        fixtures: sources.filter((s) => s.file.startsWith('prisma/fixtures/')).map((s) => s.file),
        bytes: sources.reduce((n, s) => n + s.text.length, 0),
    };
}
