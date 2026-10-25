/**
 * Every directory production code reads from the working directory is in the
 * runtime image.
 *
 * ═══ THE DEFECT ═══
 *
 * `loadSkillCorpus` reads the agent skills from
 * `path.join(process.cwd(), 'src/lib/agentic/flue/skills')`. The runtime stage
 * copies `.next`, `node_modules`, `prisma`, `dist`, `public` and the framework
 * libraries, and not that directory. So every Flue run start in production
 * threw ENOENT inside `startWorkflowRun` and answered 500 (#4301). The suite
 * never saw it: jest and the dev server both run from a checkout, where every
 * path under `src/` exists.
 *
 * It is the same shape as the framework libraries, which had no delivery path
 * until `catalogue-reaches-production.test.ts` was given one. That guard holds
 * one directory by name. This one derives the population, so the next
 * `process.cwd()` read cannot go missing the same way.
 *
 * ═══ WHAT IS SCANNED ═══
 *
 * Every non-test source file under `src/` (the web tier, and everything the
 * worker bundles imports), plus each `scripts/*.ts` that `build-worker.mjs`
 * bundles into `dist/`. Both tiers run in the image's `WORKDIR`, so a
 * cwd-relative path resolves against it.
 *
 * A read is analysable only in the form
 * `path.join|resolve(process.cwd(), '<literal>')`. Any other use of
 * `process.cwd()` fails the scan, unless `DECLARED_READS` names the directory it
 * reads and a check below proves that. A reader the scan cannot follow is
 * reported, never dropped: a scan that skips what it cannot parse reports a
 * clean bill for the subset it understands.
 *
 * ═══ WHAT THIS CANNOT SEE ═══
 *
 * It reads the Dockerfile and `.dockerignore`, not a built image. Every check
 * in this repo runs without a Docker build. A read through `__dirname` is out
 * of scope: `src/app-layer/ai/identity-match/evaluation-record.ts` resolves its
 * directory that way, and says why the worker not finding it is intended
 * (#3611).
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, repoFiles, repoRelative, repoRelativeFiles } from '../helpers/repo-files';
import { codeOf, declarationOf } from '../helpers/source-blocks';

const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

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
