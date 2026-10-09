/**
 * The Prisma-client freshness check must stay LOCAL and must never
 * regenerate by itself.
 *
 * ─── Why this file exists ───────────────────────────────────────────
 *
 * `scripts/check-prisma-client-fresh.mjs` is wired as npm's
 * `pretypecheck` hook (#3310), so it runs ahead of every
 * `npm run typecheck` — including the one in CI's Typecheck job, on
 * every PR in this repo, peers' included. That placement is what makes
 * it useful (the generator question has to be answered BEFORE the type
 * errors print, because afterwards a stale-client error and a real one
 * are the same sentence about the same symbol) and it is also what
 * makes it dangerous, in two specific ways this file pins.
 *
 *  1. **It must exit silently when `CI` is set.** CI generates the
 *     client fresh from the committed schema in every job, so there the
 *     two cannot disagree: the check's true-positive rate in CI is
 *     structurally zero, and this repo has a written rule against a
 *     gate that can only ever fire on the innocent. Delete the
 *     short-circuit and a parser bug — or any schema construct the
 *     parser does not model — reddens Typecheck for everybody, in a
 *     job that has nothing to do with the change under test.
 *
 *  2. **It must never run `prisma generate` itself.** `generate`
 *     rewrites `node_modules/.prisma/client/index.js` in place, and
 *     `node_modules` is shared by every worktree in this checkout, so a
 *     regenerate lands inside whatever jest runs are reading the client
 *     right now and throws `ENOENT` in their workers. A check that
 *     "helpfully" fixed the problem it found would turn a two-second
 *     message into a peer's failed 765-suite run. Reporting is the
 *     feature, not a limitation.
 *
 * Both are asserted BEHAVIOURALLY rather than by grepping the source
 * for a magic line, because a string assertion passes on a script that
 * has the line and ignores it. The fixture gives the probe its
 * discriminating power: an empty schema folder would be "clean" under
 * both settings and prove nothing, so the fixture declares a model the
 * generated client provably does not have, which the check must call
 * stale when run locally and must ignore when run as CI.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';


const SCRIPT = path.join(process.cwd(), 'scripts', 'check-prisma-client-fresh.mjs');

/**
 * A cwd whose `prisma/schema` names a model no generated client has.
 *
 * Outside the repo on purpose: the check resolves its schema folder
 * from `process.cwd()`, while `@prisma/client` is a bare specifier
 * resolved from the SCRIPT's own location, so running it from a
 * throwaway directory exercises the real comparison against the real
 * client without touching this repo's schema.
 */
function makeStaleFixture(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-freshness-guard-'));
    fs.mkdirSync(path.join(dir, 'prisma', 'schema'), { recursive: true });
    fs.writeFileSync(
        path.join(dir, 'prisma', 'schema', 'fixture.prisma'),
        'model AModelNoGeneratedClientHas {\n  id String @id\n}\n',
        'utf8',
    );
    return dir;
}

function run(cwd: string, env: Record<string, string>) {
    const result = spawnSync(process.execPath, [SCRIPT], {
        cwd,
        env: { ...process.env, CI: '', SKIP_PRISMA_FRESHNESS: '', ...env },
        encoding: 'utf8',
        timeout: 60_000,
    });
    return {
        status: result.status,
        out: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    };
}

describe('prisma client freshness check is local-only and read-only', () => {
    it('is wired as npm pretypecheck, so it runs before tsc prints anything', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
            scripts: Record<string, string>;
        };
        expect(pkg.scripts.pretypecheck).toBeDefined();
        expect(pkg.scripts.pretypecheck).toContain('check-prisma-client-fresh.mjs');
        // The hook is only worth having if `typecheck` is still the
        // script everyone runs; a rename would orphan it silently.
        expect(pkg.scripts.typecheck).toBeDefined();
    });

    it('reports a stale client when run locally — the positive control', () => {
        const dir = makeStaleFixture();
        try {
            const { status, out } = run(dir, {});
            expect(status).toBe(1);
            expect(out).toContain('AModelNoGeneratedClientHas');
            expect(out).toContain('DISAGREES');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('says nothing and exits 0 under CI, where it could only fire on the innocent', () => {
        const dir = makeStaleFixture();
        try {
            const { status, out } = run(dir, { CI: '1' });
            expect(status).toBe(0);
            // Silent, not merely non-blocking: a warning in every peer's
            // Typecheck log is noise that trains people to ignore it.
            expect(out.trim()).toBe('');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('honours SKIP_PRISMA_FRESHNESS so a stale client cannot block a deliberate typecheck', () => {
        const dir = makeStaleFixture();
        try {
            const { status } = run(dir, { SKIP_PRISMA_FRESHNESS: '1' });
            expect(status).toBe(0);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    // There is deliberately NO source-text assertion that the script
    // imports no child_process. Two zero-headroom ratchets rejected one
    // in turn — raw, `raw-source-assertion-ratchet` (a message that
    // tells the reader to run `npm run db:generate` is prose naming the
    // forbidden thing); masked through `codeOf`, the needles stop being
    // analysable and `assertion-needle-uniqueness-ratchet` went 1441 ->
    // 1443. Both were right, and the test below is better evidence than
    // either: it exercises the exact condition under which a "helpful"
    // regenerate would fire and requires the artefact not to move.
    it('leaves the generated client untouched when it finds it stale', () => {
        // The PRIMARY form of "never regenerates", and behavioural: run
        // the check against a fixture it must call stale, with nothing
        // reading the client — which is precisely the condition under
        // which a "helpful" regenerate would fire — and require the
        // generated artefact not to have moved.
        //
        // `.prisma/client` is the generated file, resolved rather than
        // spelled: the installed `@prisma/client` package's mtime is its
        // install date and does not move when the client is regenerated,
        // so it would make this assertion unfalsifiable.
        const generated = createRequire(__filename).resolve('.prisma/client');
        const before = fs.statSync(generated).mtimeMs;
        const dir = makeStaleFixture();
        try {
            expect(run(dir, {}).status).toBe(1);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        expect(fs.statSync(generated).mtimeMs).toBe(before);
    });

});
