/**
 * `patches/` reaches the image before `npm ci` runs.
 *
 * ## The regression this catches
 *
 * `postinstall` is `patch-package`. It applies every patch in `patches/` — and
 * when that directory is absent it prints "No patch files found" and exits 0.
 * A successful install and a completely skipped patch set are therefore the
 * same exit code and, from CI's point of view, the same build.
 *
 * The Dockerfile used to `COPY package.json package-lock.json` and immediately
 * `RUN npm ci`, with `patches/` only arriving later via the builder stage's
 * `COPY . .`. So every patch applied locally and in CI (where `npm ci` runs in
 * a full checkout) and silently did NOT apply in the shipped image. A
 * divergence that appears only in production, with nothing red anywhere, is the
 * worst available shape for this bug.
 *
 * ## Why this assertion is structural
 *
 * The honest behavioural test is "build the image and confirm a patch is
 * present in node_modules", which needs a Docker build — and, with zero patches
 * currently checked in, would have nothing to observe. The invariant here is
 * genuinely about instruction ORDER in a build file, so order is what is
 * asserted. There is no runtime seam to test instead.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

function dockerfileInstructions(): string[] {
    return fs
        .readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8')
        .split('\n')
        .map((l) => l.trim())
        // Comments must go: this file's own prose names both instructions and
        // would otherwise satisfy the ordering check on its own.
        .filter((l) => l.length > 0 && !l.startsWith('#'));
}

describe('Dockerfile applies patches during install', () => {
    it('copies patches/ before the npm ci that triggers patch-package', () => {
        const lines = dockerfileInstructions();
        const copyPatches = lines.findIndex((l) => /^COPY\s+patches\b/.test(l));
        const npmCi = lines.findIndex((l) => /^RUN\s+npm\s+ci\b/.test(l));

        expect(npmCi).toBeGreaterThan(-1);
        expect(copyPatches).toBeGreaterThan(-1);
        expect(copyPatches).toBeLessThan(npmCi);
    });

    it('keeps patches/ present, since Docker COPY fails on a missing source', () => {
        // Git does not track empty directories. If the last patch is deleted
        // and nothing holds the directory open, `COPY patches ./patches` breaks
        // the image build — and the tempting fix is to delete that line, which
        // silently restores the original bug.
        expect(fs.existsSync(path.join(ROOT, 'patches'))).toBe(true);
        expect(fs.readdirSync(path.join(ROOT, 'patches')).length).toBeGreaterThan(0);
    });

    it('still runs patch-package on postinstall, so the ordering matters at all', () => {
        // If the hook is ever dropped, this whole guard is theatre. Fail loudly
        // rather than keep asserting an ordering that protects nothing.
        const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
        expect(pkg.scripts?.postinstall).toMatch(/patch-package/);
    });

    it('does not exclude patches/ from the build context', () => {
        // A .dockerignore entry would make COPY fail (or copy nothing),
        // reintroducing the skip from a completely different file.
        const ignore = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8');
        const excluded = ignore
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l && !l.startsWith('#'))
            .some((l) => /^\/?patches\/?$/.test(l));
        expect(excluded).toBe(false);
    });
});
