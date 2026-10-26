/**
 * Every control-template fixture the repo ships can actually arrive in
 * production.
 *
 * ═══ WHY THIS IS NOT THE GUARD NEXT DOOR ═══
 *
 * `authored-tasks-are-delivered.test.ts` asks whether a fixture carrying
 * authored tasks is REFERENCED by a production seeder. That is a wiring
 * question, and wiring is not arrival.
 *
 * Measured on 2026-09-06 by seeding two clean databases — one by
 * `prisma/seed.ts`, one by the five seeders `scripts/entrypoint.sh` runs — and
 * diffing them:
 *
 *   Framework                       dev 17   prod  5
 *   ControlTemplate                 dev 512  prod 237
 *   FrameworkRequirement            dev 1134 prod 262
 *   ControlTemplateRequirementLink  dev 1912 prod 287
 *
 * Both fixtures that proved the point have since left. `dora-` and `nis2-`
 * were each named by the task seeder, so the wiring guard was green for them,
 * while their templates were created by neither production seeder — on a fresh
 * database the task seeder found nothing to attach to and said so, still
 * exiting 0:
 *
 *   DORA: 133 authored -> created 0 ⚠ 24 template(s) absent
 *   NIS2: 105 authored -> created 0 ⚠ 20 template(s) absent
 *
 * 238 authored tasks, zero rows, exit code 0. That is the same defect the
 * neighbouring guard exists to prevent, committed one level up by the guard
 * itself — it proved the reference and not the consequence.
 *
 * Read "fresh database" strictly. Live production HELD those 238 rows, because
 * its templates were put there by a one-off backfill years after the seeders
 * were written, so the task seeder found them. The exposure was never today's
 * data; it was a fresh deploy or a restore. The catalogue was not reproducible
 * from the repo, only recoverable from a database that already had it.
 *
 * Both are now CatalogFiles applied by scripts/seed-framework-catalogs.ts, so
 * one writer creates the templates and reconciles the tasks together and they
 * cannot come apart again.
 *
 * ═══ WHAT DELIVERS A TEMPLATE IN PRODUCTION ═══
 *
 * Exactly two things, and the prod image bundles only these:
 *   • `scripts/seed-framework-catalogs.ts` — applies a CatalogFile, creating
 *     the framework, requirements, templates, links and pack together.
 *   • `seedInternalControls`, called by `scripts/seed-control-template-tasks.ts`
 *     for `internal-controls.json` only.
 *
 * `prisma/seed.ts` is NOT one of them: it is not run on production deploys.
 * Neither is `scripts/backfill-framework-catalog.mjs`, a completed one-off that
 * nothing invokes — production holds the rest of its catalogue because a human
 * ran that once, which is not a delivery path.
 *
 * ═══ WHAT THIS CANNOT SEE ═══
 *
 * Populations `prisma/seed.ts` generates INLINE reach no fixture, so a
 * fixture-keyed scan is blind to them by construction. Naming that limit here
 * rather than implying full coverage.
 *
 * THERE IS NO COMPANION CHECK THAT SEES EVERYTHING, and this docblock used to
 * say there was — it pointed at `tests/integration/catalogue-parity.test.ts`,
 * which has never existed in the tree. That is worse than saying nothing: a
 * reader told a stronger check lives elsewhere stops looking for one, so the
 * gap stays open AND stays unrecorded. If such a check is ever written, name
 * it here; until then the limit above is simply open (#2645).
 *
 * ISO 27001 ANNEX A USED TO BE THE EXAMPLE HERE, AND IT IS NO LONGER TRUE.
 * `prisma/fixtures/iso27001-control-templates.json` carries all 93 A-* templates
 * and 93 requirements, and `scripts/seed-framework-catalogs.ts` lists it — so
 * Annex A has a delivery path and this scan does see it. The claim did not move;
 * the catalogue did, and the prose stayed where it was (#2624). Corrected rather
 * than deleted, because the limit above is still real for whatever remains
 * inline.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, repoFiles, repoRelative, repoRelativeFiles } from '../helpers/repo-files';
import { callExpressionOf, codeOf, declarationOf } from '../helpers/source-blocks';
import { computeLibraryTextHash, parseLibraryFile, scanLibraryDirectory } from '@/app-layer/libraries';

const FIXTURE_DIR = path.join(REPO_ROOT, 'prisma/fixtures');
const CATALOG_SEEDER = path.join(REPO_ROOT, 'scripts/seed-framework-catalogs.ts');
const TASK_SEEDER = path.join(REPO_ROOT, 'scripts/seed-control-template-tasks.ts');

/**
 * The one fixture whose templates a seeder other than the catalog seeder
 * creates. `seedInternalControls` writes templates, policy links and tasks
 * together for this file and no other.
 */
const INTERNAL_CONTROLS = 'internal-controls.json';

/**
 * Template fixtures with no production delivery path, and the reason.
 *
 * A DOWNWARD RATCHET, and its end state is empty. Each entry is a framework a
 * fresh production database would simply not have. Closing one means giving it
 * a real path — reshaping the fixture into a CatalogFile and adding it to
 * `CATALOG_FIXTURES` — not deleting the line.
 *
 * Do not add an entry to make this pass. A NEW template fixture with no
 * delivery path is the bug this file is named for.
 */
const TEMPLATES_UNDELIVERED: Record<string, string> = {};

/** Fixtures listed in CATALOG_FIXTURES in the catalog seeder. */
function catalogFixtures(): Set<string> {
    const src = fs.readFileSync(CATALOG_SEEDER, 'utf8');
    const block = src.slice(src.indexOf('CATALOG_FIXTURES'));
    const names = new Set<string>();
    for (const m of block.matchAll(/prisma\/fixtures\/([A-Za-z0-9._-]+\.json)/g)) names.add(m[1]);
    return names;
}

/** Every fixture that declares at least one control-template code. */
function templateFixtures(): Array<{ file: string; codes: number }> {
    return fs
        .readdirSync(FIXTURE_DIR)
        .filter((f) => f.endsWith('.json'))
        .flatMap((file) => {
            let raw: unknown;
            try {
                raw = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8'));
            } catch {
                return [];
            }
            const obj = (raw ?? {}) as { controls?: unknown[]; templates?: unknown[] };
            const list = (Array.isArray(raw) ? raw : (obj.templates ?? obj.controls ?? [])) as Array<{
                code?: unknown;
            }>;
            const codes = list.filter((t) => typeof t?.code === 'string').length;
            return codes > 0 ? [{ file, codes }] : [];
        });
}

describe('the shipped catalogue can reach production', () => {
    const fixtures = templateFixtures();
    const delivered = catalogFixtures();

    it('the scan sees template fixtures at all (denominator, not findings)', () => {
        // Every assertion below is satisfied by an empty list, which is the
        // shape of the bug one level up: a scan that stops matching reports a
        // clean bill of health for the subset it still understands.
        expect(fixtures.length).toBeGreaterThanOrEqual(10);
        expect(fixtures.reduce((n, f) => n + f.codes, 0)).toBeGreaterThan(300);
    });

    it('the catalog seeder names fixtures that exist and carry templates', () => {
        // A name in CATALOG_FIXTURES that matches no template-carrying fixture
        // is a delivery path to nothing, and would make the check below pass
        // for a framework that ships nothing.
        const carry = new Set(fixtures.map((f) => f.file));
        const bogus = [...delivered].filter(
            (f) => !fs.existsSync(path.join(FIXTURE_DIR, f)) || !carry.has(f),
        );
        expect(bogus).toEqual([]);
    });

    it('every template fixture has a production delivery path', () => {
        const orphans = fixtures
            .filter(({ file }) => file !== INTERNAL_CONTROLS && !delivered.has(file))
            .filter(({ file }) => !TEMPLATES_UNDELIVERED[file])
            .map(({ file, codes }) => `${file} (${codes} templates, no prod path)`);
        expect(orphans).toEqual([]);
    });

    it('seedInternalControls really is the internal-controls path', () => {
        // The exemption above is only honest while this holds. If the task
        // seeder stops calling seedInternalControls, internal-controls.json
        // joins the orphans and must not stay silently exempt.
        //
        // Both needles are bound to a construct rather than to the whole file.
        // `callExpressionOf` THROWS when the call is gone, so a rename fails
        // loudly instead of leaving a `toContain` to be satisfied by some
        // unrelated mention elsewhere in the seeder — the Class D shape this
        // repo ratchets down.
        const src = fs.readFileSync(TASK_SEEDER, 'utf8');
        expect(callExpressionOf(src, 'seedInternalControls')).toContain('FIXTURE');
        expect(declarationOf(src, 'FIXTURE')).toContain(INTERNAL_CONTROLS);
    });

    it('every exemption is real, still undelivered, and still carries templates', () => {
        const carry = new Map(fixtures.map((f) => [f.file, f.codes]));
        const stale = Object.keys(TEMPLATES_UNDELIVERED).filter(
            (f) =>
                !fs.existsSync(path.join(FIXTURE_DIR, f)) ||
                delivered.has(f) ||
                !carry.get(f),
        );
        expect(stale).toEqual([]);
    });

    it('records how many templates cannot reach production, so it stays visible', () => {
        // 54 across three fixtures — the frozen ISO 9001 / 28000 / 39001 sets.
        // Was 98 across five; DORA (24) and NIS2 (20) left by being reshaped
        // into CatalogFiles and wired into CATALOG_FIXTURES. Only ever down.
        //
        // What remains is a different problem from the one this ratchet
        // measures. Those three have no source library, so they are frozen for
        // CONTENT in control-task-actionability; delivering them would ship 54
        // templates whose every task is a generic placeholder. Delivery and
        // content are separate axes and this number speaks only to the first.
        const carry = new Map(fixtures.map((f) => [f.file, f.codes]));
        const undelivered = Object.keys(TEMPLATES_UNDELIVERED).reduce(
            (n, f) => n + (carry.get(f) ?? 0),
            0,
        );
        expect(Object.keys(TEMPLATES_UNDELIVERED)).toEqual([]);
        expect(undelivered).toBe(0);
    });
});

/**
 * ═══ THE FRAMEWORK LIBRARIES AND THEIR CROSSWALKS, THE SAME QUESTION ═══
 *
 * The YAML libraries and mapping sets in `src/data/libraries/` had no delivery
 * path either, for as long as the crosswalks existed. `syncAllLibraries` is the
 * only writer of library framework rows and of `RequirementMapping`, and
 * nothing a deployment ran called it, so inherited coverage, gap analysis and
 * traceability read an empty mapping table in production while every test
 * passed against rows its own `beforeAll` had imported.
 *
 * Folded in here rather than given a file of its own because it is this file's
 * invariant, that what the repo ships reaches production, over a second
 * population. The path has four links, and each one alone looks finished:
 *
 *   1. `scripts/build-worker.mjs` bundles the script into `dist/`, because the
 *      production image cannot run TypeScript;
 *   2. the Dockerfile copies `src/data/libraries` into the runtime image, which
 *      otherwise carries `prisma/` and `dist/` and no YAML at all;
 *   3. the script reads the YAML from the working directory, which is where
 *      the Dockerfile puts it, not from `__dirname`, which in a bundle is
 *      `dist/`;
 *   4. `scripts/entrypoint.sh` runs the bundle AFTER the catalogue seed: the
 *      sync leaves every row that has a pack to the catalogue, so the packs
 *      must exist first.
 *
 * What the sync then DOES is held by
 * `tests/integration/framework-library-startup-sync.test.ts`; this holds only
 * that it is reached.
 */
const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
const trimmedLines = (rel: string): string[] => read(rel).split('\n').map((l) => l.trim());

const LIBRARY_SYNC_SCRIPT = 'scripts/sync-framework-libraries.ts';
const LIBRARY_SYNC_BUNDLE = 'dist/sync-framework-libraries.mjs';
const RUN_LIBRARY_SYNC = `node ${LIBRARY_SYNC_BUNDLE} || echo "⚠ framework-library sync incomplete (non-fatal)"`;
const RUN_CATALOGUE_SEED =
    'node dist/seed-framework-catalogs.mjs || echo "⚠ framework-catalog seed skipped (non-fatal)"';
const COPY_LIBRARIES = 'COPY --from=builder /app/src/data/libraries ./src/data/libraries';

describe('the framework libraries reach production', () => {
    it('the script exists', () => {
        expect(fs.existsSync(path.join(REPO_ROOT, LIBRARY_SYNC_SCRIPT))).toBe(true);
    });

    it('build-worker bundles it into dist/', () => {
        // One `await build({...})` call per bundle; the one naming the script
        // must also name the bundle the entrypoint runs.
        const builds = read('scripts/build-worker.mjs').split('await build(');
        const own = builds.filter((b) => b.includes(`entryPoints: ['${LIBRARY_SYNC_SCRIPT}']`));
        expect(own).toHaveLength(1);
        expect(own[0].slice(0, own[0].indexOf('});'))).toContain(`outfile: '${LIBRARY_SYNC_BUNDLE}'`);
    });

    it('the runtime image carries the YAML', () => {
        const dockerfile = trimmedLines('Dockerfile');
        const runtimeStage = dockerfile.map((l) => l.startsWith('FROM ')).lastIndexOf(true);
        expect(runtimeStage).toBeGreaterThanOrEqual(0);
        expect(dockerfile.indexOf(COPY_LIBRARIES)).toBeGreaterThan(runtimeStage);
    });

    it('the script reads the YAML from where the image puts it', () => {
        // `./src/data/libraries` under WORKDIR /app, and a cwd-relative path in
        // the script. A `__dirname` path would resolve against `dist/`.
        const src = trimmedLines(LIBRARY_SYNC_SCRIPT);
        expect(src).toContain(`const librariesDir = path.resolve(process.cwd(), 'src/data/libraries');`);
        expect(src.filter((l) => l.includes('__dirname') && !l.startsWith('*') && !l.startsWith('//'))).toEqual([]);
    });

    it('the entrypoint runs the bundle, after the catalogue seed', () => {
        const entrypoint = trimmedLines('scripts/entrypoint.sh');
        const catalogue = entrypoint.indexOf(RUN_CATALOGUE_SEED);
        const sync = entrypoint.indexOf(RUN_LIBRARY_SYNC);
        expect(catalogue).toBeGreaterThanOrEqual(0);
        expect(sync).toBeGreaterThan(catalogue);
    });
});

/**
 * ═══ EVERY DIRECTORY PRODUCTION READS FROM THE WORKING DIRECTORY, DERIVED ═══
 *
 * The libraries above are one directory, held by name. The agent skills were a
 * second, and nothing held them: `loadSkillCorpus` reads
 * `path.join(process.cwd(), 'src/lib/agentic/flue/skills')`, the runtime stage
 * did not copy it, and every Flue run start in production threw ENOENT and
 * answered 500 (#4301). The suite never saw it, because jest and the dev
 * server both run from a checkout, where every path under `src/` exists.
 *
 * So this derives the population instead of naming it. It scans every non-test
 * source file under `src/` (the web tier, and everything the worker bundles
 * import) and each `scripts/*.ts` that `build-worker.mjs` bundles into `dist/`.
 * Both tiers run in the image's `WORKDIR`, so a cwd-relative path resolves
 * against it.
 *
 * A read is analysable only in the form
 * `path.join|resolve(process.cwd(), '<literal>')`. Any other use of
 * `process.cwd()` fails the scan, unless `DECLARED_READS` names the directory it
 * reads and a check below proves that. A reader the scan cannot follow is
 * reported, never dropped.
 *
 * WHAT THIS CANNOT SEE. It reads the Dockerfile and `.dockerignore`, not a
 * built image. A read through `__dirname` is out of scope:
 * `src/app-layer/ai/identity-match/evaluation-record.ts` resolves its directory
 * that way, and says why the worker not finding it is intended (#3611).
 */
/**
 * A `process.cwd()` read whose path is not a literal, the directory it reads,
 * and the check that proves it. Keep this short: the cure for an entry is to
 * write the read in the literal form.
 */
const DECLARED_READS: Record<string, { dir: string; reason: string }> = {
    'scripts/seed-framework-catalogs.ts': {
        dir: 'prisma/fixtures',
        reason: 'resolves each CATALOG_FIXTURES entry, and every entry is a prisma/fixtures/ path (asserted below)',
    },
};

const LITERAL_READ = /path\.(?:join|resolve)\(\s*process\.cwd\(\)\s*,\s*'([^']+)'\s*\)/g;
const ANY_CWD = /process\.cwd\(\)/g;

/** The `scripts/*.ts` entry points `build-worker.mjs` bundles into `dist/`. */
function bundledScripts(): string[] {
    const src = read('scripts/build-worker.mjs');
    return [...src.matchAll(/entryPoints:\s*\['(scripts\/[^']+\.ts)'\]/g)].map((m) => m[1]);
}

/** Non-test source under `src/`. */
function sourceFiles(): string[] {
    return repoFiles({ under: 'src', extensions: ['.ts', '.tsx', '.js', '.mjs'] })
        .map(repoRelative)
        .filter((rel) => !/(^|\/)__tests__\//.test(rel) && !/\.test\.[jt]sx?$/.test(rel));
}

interface CwdReads {
    /** Directory → the files that read it. */
    readonly reads: Map<string, string[]>;
    /** `file: count` for every `process.cwd()` the literal form did not account for. */
    readonly unanalysable: string[];
}

function cwdReads(files: readonly string[], text: (rel: string) => string): CwdReads {
    const reads = new Map<string, string[]>();
    const unanalysable: string[] = [];
    for (const rel of files) {
        const code = codeOf(text(rel));
        const all = (code.match(ANY_CWD) ?? []).length;
        if (all === 0) continue;
        const literal = [...code.matchAll(LITERAL_READ)].map((m) => path.posix.normalize(m[1]));
        for (const dir of literal) reads.set(dir, [...(reads.get(dir) ?? []), rel]);
        const declared = DECLARED_READS[rel];
        if (declared) {
            reads.set(declared.dir, [...(reads.get(declared.dir) ?? []), rel]);
        } else if (all > literal.length) {
            unanalysable.push(`${rel}: ${all - literal.length} process.cwd() not in the literal form`);
        }
    }
    return { reads, unanalysable };
}

/**
 * The runtime stage's `COPY --from=builder /app/<p> ./<p>` paths, and its
 * `WORKDIR`. A copy that lands somewhere other than its own path under
 * `WORKDIR` does not serve a cwd-relative read, so it is not listed.
 */
function runtimeCopies(dockerfile: string): { workdir: string | null; copied: string[] } {
    const lines = dockerfile
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '' && !l.startsWith('#'));
    const lastFrom = lines.map((l) => /^FROM\s/i.test(l)).lastIndexOf(true);
    const stage = lastFrom === -1 ? [] : lines.slice(lastFrom + 1);
    const workdirs = stage.filter((l) => /^WORKDIR\s/i.test(l)).map((l) => l.split(/\s+/)[1]);
    const copied: string[] = [];
    for (const l of stage) {
        const m = /^COPY\s+--from=builder\s+\/app\/(\S+?)\/?\s+\.\/(\S+?)\/?$/.exec(l);
        if (m && m[1] === m[2]) copied.push(m[1]);
    }
    return { workdir: workdirs.length > 0 ? workdirs[workdirs.length - 1] : null, copied };
}

/** Directories no runtime copy covers: neither copied nor under a copied path. */
function uncovered(dirs: readonly string[], copied: readonly string[]): string[] {
    return dirs.filter((dir) => !copied.some((c) => dir === c || dir.startsWith(`${c}/`)));
}

/** A `.dockerignore` pattern as an anchored regex over a context-relative path. */
function ignoreRegex(pattern: string): RegExp {
    const p = pattern.replace(/^\/+/, '').replace(/\/+$/, '');
    let re = '';
    for (let i = 0; i < p.length; i++) {
        const ch = p[i];
        if (ch === '*' && p[i + 1] === '*') {
            // `**/` is zero or more directories; a trailing `**` is anything.
            if (p[i + 2] === '/') {
                re += '(?:.*/)?';
                i += 2;
            } else {
                re += '.*';
                i += 1;
            }
        } else if (ch === '*') re += '[^/]*';
        else if (ch === '?') re += '[^/]';
        else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${re}$`);
}

/**
 * Is a context-relative file excluded from the build context? The last pattern
 * that matches the file or one of its parent directories decides, and a `!`
 * pattern re-includes.
 */
function ignoredBy(dockerignore: string): (file: string) => boolean {
    const rules = dockerignore
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '' && !l.startsWith('#'))
        .map((l) => (l.startsWith('!') ? { negate: true, re: ignoreRegex(l.slice(1)) } : { negate: false, re: ignoreRegex(l) }));
    return (file) => {
        const parts = file.split('/');
        const prefixes = parts.map((_, i) => parts.slice(0, i + 1).join('/'));
        let ignored = false;
        for (const rule of rules) {
            if (prefixes.some((p) => rule.re.test(p))) ignored = !rule.negate;
        }
        return ignored;
    };
}

describe('every directory production reads from the working directory is in the image (#4301)', () => {
    const scanned = [...sourceFiles(), ...bundledScripts()];
    const { reads, unanalysable } = cwdReads(scanned, read);
    const dirs = [...reads.keys()].sort();
    const { workdir, copied } = runtimeCopies(read('Dockerfile'));

    it('the scan sees what it scans (denominator, not findings)', () => {
        // Every assertion below is satisfied by an empty population.
        expect(sourceFiles().length).toBeGreaterThan(1000);
        expect(bundledScripts().length).toBeGreaterThanOrEqual(8);
        expect(dirs).toEqual(expect.arrayContaining(['src/lib/agentic/flue/skills', 'src/data/libraries']));
        expect(copied.length).toBeGreaterThanOrEqual(5);
    });

    it('every process.cwd() read is in a form the scan can follow', () => {
        expect(unanalysable).toEqual([]);
    });

    it('both tiers run in /app, where the copies land', () => {
        expect(workdir).toBe('/app');
    });

    it('the runtime stage copies every directory read', () => {
        const missing = uncovered(dirs, copied).map((d) => `${d} (read by ${reads.get(d)?.join(', ')})`);
        expect(missing).toEqual([]);
    });

    it('no file in a directory read is left out of the build context', () => {
        // A COPY of a directory the context does not carry copies nothing, or
        // copies a directory with its SKILL.md files missing.
        const isIgnored = ignoredBy(read('.dockerignore'));
        const tracked = repoRelativeFiles();
        const dropped = dirs.flatMap((dir) => tracked.filter((f) => f.startsWith(`${dir}/`) && isIgnored(f)));
        expect(dropped).toEqual([]);
    });

    it('every directory read holds files, so the copy carries something', () => {
        const tracked = repoRelativeFiles();
        const empty = dirs.filter((dir) => !tracked.some((f) => f.startsWith(`${dir}/`)));
        expect(empty).toEqual([]);
    });

    it('each declared read reads only the directory it is declared to', () => {
        const entries = [...declarationOf(read('scripts/seed-framework-catalogs.ts'), 'CATALOG_FIXTURES').matchAll(/'([^']+)'/g)].map(
            (m) => m[1],
        );
        expect(entries.length).toBeGreaterThan(0);
        expect(entries.filter((e) => !e.startsWith(`${DECLARED_READS['scripts/seed-framework-catalogs.ts'].dir}/`))).toEqual([]);
        expect(Object.keys(DECLARED_READS).filter((f) => !scanned.includes(f))).toEqual([]);
    });
});

describe('the readers report what they are for (positive controls on synthetic input)', () => {
    const runtime = (copies: string): string =>
        ['FROM node AS builder', 'WORKDIR /app', 'COPY --from=builder /app/x ./x', 'FROM node AS runner', 'WORKDIR /app', copies].join('\n');

    it('a directory with no runtime copy is reported', () => {
        const { copied } = runtimeCopies(runtime('COPY --from=builder /app/prisma ./prisma'));
        expect(uncovered(['src/lib/agentic/flue/skills'], copied)).toEqual(['src/lib/agentic/flue/skills']);
    });

    it('a copy in the builder stage only does not count', () => {
        expect(runtimeCopies(runtime('')).copied).toEqual([]);
    });

    it('a copy of an ancestor covers it; a copy to another path does not', () => {
        expect(uncovered(['src/a/b'], runtimeCopies(runtime('COPY --from=builder /app/src ./src')).copied)).toEqual([]);
        expect(uncovered(['src/a/b'], runtimeCopies(runtime('COPY --from=builder /app/src/a/b ./b')).copied)).toEqual(['src/a/b']);
        expect(uncovered(['src/ab'], runtimeCopies(runtime('COPY --from=builder /app/src/a ./src/a')).copied)).toEqual(['src/ab']);
    });

    it('a commented-out copy does not count', () => {
        expect(runtimeCopies(runtime('# COPY --from=builder /app/src ./src')).copied).toEqual([]);
    });

    it('a non-literal process.cwd() is reported, a literal one is read', () => {
        const files: Record<string, string> = {
            'a.ts': "const d = path.join(process.cwd(), 'src/x');",
            'b.ts': 'const d = path.join(process.cwd(), dir);',
            'c.ts': '// process.cwd() in a comment is not a read',
        };
        const { reads, unanalysable } = cwdReads(Object.keys(files), (f) => files[f]);
        expect([...reads.keys()]).toEqual(['src/x']);
        expect(unanalysable).toEqual(['b.ts: 1 process.cwd() not in the literal form']);
    });

    it('.dockerignore: a pattern on a parent or a file drops it, and a later ! keeps it', () => {
        const file = 'src/lib/agentic/flue/skills/soa-authoring/SKILL.md';
        expect(ignoredBy('src/lib/')(file)).toBe(true);
        expect(ignoredBy('**/*.md')(file)).toBe(true);
        expect(ignoredBy('**/*.md')('README.md')).toBe(true);
        expect(ignoredBy('**/*.md\n!src/lib/agentic/flue/skills/**')(file)).toBe(false);
        expect(ignoredBy('README.md\ndocs/\ntests/')(file)).toBe(false);
    });
});

/**
 * ═══ A LIBRARY'S TEXT CHANGE REACHES A DATABASE THAT ALREADY HAS IT ═══
 *
 * The library import skips a library whose content hash matches the stored
 * one, and that hash covers the urn, the version and the node urns. Not the
 * text: a reworded title or description, or a corrected copyright line, under
 * the same version is skipped by every database already holding the library.
 * Nothing fails. The edit simply never arrives, which since the container-start
 * sync is production.
 *
 * Folding the text into that hash would deliver it, but under the same version
 * the importer would record a `vN -> vN` diff, and a second such edit would
 * upsert onto that row (`@@unique([frameworkKey, fromVersion, toVersion])`)
 * instead of getting its own, so the tenants notified of the first change
 * would not hear of the second. The version is the right signal; this makes it
 * move.
 *
 * Each library records `text_hash`, `computeLibraryTextHash` of its content as
 * of its version. When the content changes, this fails and names both values
 * to write. CI checks out one commit, so this cannot see the version the file
 * had on the base, and an edit that rewrites `text_hash` without bumping
 * `version` gets past it. That edit is a deliberate change to the line beside
 * the version, in the diff a reviewer reads. A forgotten bump, the case that
 * happens, is caught.
 *
 * Mapping sets need no equivalent: they record no diff, so their own hash
 * covers their text (`computeMappingSetHash`).
 */
const LIBRARIES_DIR = path.join(REPO_ROOT, 'src/data/libraries');

describe("a library's text change reaches a database that already holds it", () => {
    const libraries = scanLibraryDirectory(LIBRARIES_DIR).map((e) => ({
        file: path.basename(e.filePath),
        stored: parseLibraryFile(e.filePath),
    }));

    it('the scan sees the shipped libraries (denominator, not findings)', () => {
        expect(libraries.length).toBeGreaterThanOrEqual(10);
    });

    it('every library records the fingerprint of its content as of its version', () => {
        const stale = libraries.flatMap(({ file, stored }) => {
            const actual = computeLibraryTextHash(stored);
            if (stored.text_hash === actual) return [];
            const v = stored.version;
            return [
                stored.text_hash === undefined
                    ? `${file}: records no text_hash. Add "text_hash: ${actual}" under "version: ${v}".`
                    : `${file}: its content changed since version ${v} was recorded. ` +
                      `Bump to "version: ${v + 1}" and set "text_hash: ${actual}", ` +
                      `or the change reaches no database that already holds the library.`,
            ];
        });
        expect(stale).toEqual([]);
    });
});

/**
 * ═══ A SEEDED DEV OR E2E DATABASE GETS WHAT THE CONTAINER START GIVES ═══
 *
 * `prisma/seed.ts` builds the dev and E2E databases and is not run on a deploy.
 * It now calls `syncLibrariesAtStartup`, the function the container start
 * calls, so those databases get the library rows and every crosswalk.
 *
 * The sync leaves alone every framework row a catalogue owns (one with a
 * pack). Two catalogues declare the same key as their library (AIUC-1, COSO),
 * and in production the catalogue writes that row first. If `seed.ts` stops
 * applying one of them, or applies it after the sync, the sync finds no
 * catalogue row, writes the library's instead, and the framework has the
 * opposite owner in dev and E2E with no pack to install. Nothing else fails:
 * the crosswalks resolve against either row. So each such catalogue must be
 * applied in `seed.ts` before the sync. The population is derived, not listed:
 * the catalogue seeder's fixtures whose framework key a library also declares.
 *
 * More generally, `seed.ts` applies every fixture the catalogue seeder applies.
 * The internal-controls catalogue was the one it missed, so a dev or E2E
 * database had that library's templates and neither the framework nor the
 * pack that installs them.
 */
const SEED = 'prisma/seed.ts';

describe('a seeded dev or E2E database gets what the container start gives', () => {
    const seed = codeOf(read(SEED));
    const libraryKeys = new Set(
        scanLibraryDirectory(LIBRARIES_DIR).map((e) => parseLibraryFile(e.filePath).objects.framework.ref_id),
    );
    const sharedKey = [...catalogFixtures()].filter((file) => {
        const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8')) as {
            framework?: { key?: string };
        };
        return fixture.framework?.key !== undefined && libraryKeys.has(fixture.framework.key);
    });

    it('finds the catalogues that share a key with their library (denominator)', () => {
        expect(sharedKey.length).toBeGreaterThanOrEqual(2);
    });

    it('the seed runs the container start\'s library sync', () => {
        expect(callExpressionOf(seed, 'syncLibrariesAtStartup')).toMatch(/^syncLibrariesAtStartup\(prisma,/);
    });

    it('the seed applies every catalogue the container start applies', () => {
        // Each of these carries a framework and a pack that reach a deployed
        // database only through the catalogue seeder. A fixture missing here
        // exists in production and not in dev or E2E, as the internal-controls
        // catalogue did: its 151 templates seeded, and no pack to install them.
        const missing = [...catalogFixtures()].filter((file) => !seed.includes(`'prisma/fixtures/${file}'`));
        expect(missing).toEqual([]);
    });

    it('the seed applies each of those catalogues before the sync', () => {
        const sync = seed.indexOf('syncLibrariesAtStartup(');
        const late = sharedKey.filter((file) => {
            const at = seed.indexOf(`'prisma/fixtures/${file}'`);
            return at < 0 || at > sync;
        });
        expect(late).toEqual([]);
    });
});
