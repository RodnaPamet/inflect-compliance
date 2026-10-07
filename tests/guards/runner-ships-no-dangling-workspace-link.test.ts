/**
 * The runtime image must not ship a workspace symlink whose target it omits.
 *
 * ═══ THE DEFECT ═══
 *
 * `npm ci` creates `node_modules/@inflect/ui -> ../../packages/ui` for the
 * workspace declared by `"workspaces": ["packages/*"]`, and
 * `npm prune --omit=dev` KEEPS it — a workspace link is not a dev dependency.
 * The runner stage then copies `.next`, `node_modules`, `package.json`,
 * `prisma`, `public`, `dist` and two scripts. It does not copy `packages/`.
 *
 * So the image contained a symlink pointing at a path it does not have (#3204).
 * It was harmless while `packages/ui` was an empty skeleton; as of #3046 step 2b
 * the package holds the Nucleo barrel and `cn.ts`, which 218 modules import.
 *
 * ═══ WHY THIS SHAPE OF ASSERTION ═══
 *
 * The INVARIANT is "no dangling link", and there are two honest ways to satisfy
 * it — remove the link, or ship `packages/`. Asserting one specific line would
 * redden a future change that satisfied the invariant the other way, and a guard
 * people route around is worse than no guard. So this accepts either remedy and
 * fails only when NEITHER holds.
 *
 * It reads the Dockerfile rather than the built image because every check in this
 * repo runs without a Docker build; that is a real limit, stated rather than
 * hidden. The image-level verification is in #3204.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const DOCKERFILE = path.join(ROOT, 'Dockerfile');

/**
 * Dockerfile instructions only, with `#` comment lines dropped.
 *
 * This exists because the first draft of this guard PASSED on a tree with the
 * removal deleted: the explanatory comment beside it contains the phrase
 * `rm -rf node_modules/@inflect`, and that satisfied the reader. A guard a
 * COMMENT can satisfy is the #2246 Class A defect, and the mutation proof below
 * is what reported it.
 */
function codeOnly(text: string): string {
    return text
        .split('\n')
        .filter((l) => !/^\s*#/.test(l))
        .join('\n');
}

/** The runner stage's body — everything after its `FROM ... AS runner`. */
function runnerStage(text: string): string {
    const lines = text.split('\n');
    const start = lines.findIndex((l) => /^FROM\s.+\sAS\s+runner\b/.test(l));
    if (start === -1) return '';
    const rest = lines.slice(start + 1);
    const next = rest.findIndex((l) => /^FROM\s/.test(l));
    return codeOnly((next === -1 ? rest : rest.slice(0, next)).join('\n'));
}

/** Everything before the runner stage — where the prune and any cleanup live. */
function beforeRunner(text: string): string {
    const lines = text.split('\n');
    const start = lines.findIndex((l) => /^FROM\s.+\sAS\s+runner\b/.test(l));
    return codeOnly((start === -1 ? lines : lines.slice(0, start)).join('\n'));
}

const WORKSPACE_LINK = /rm\s+(-[a-zA-Z]+\s+)*node_modules\/@inflect(\/ui)?\b/;
const SHIPS_PACKAGES = /^COPY\s+--from=\w+\s+\/app\/packages\s/m;

describe('the runtime image ships no dangling workspace symlink (#3204)', () => {
    const text = fs.readFileSync(DOCKERFILE, 'utf8');

    it('the Dockerfile declares a runner stage, so the readers below are not scanning nothing', () => {
        // An empty selection satisfies every assertion that follows. If the
        // stage is ever renamed, this is what reports it instead of the file
        // quietly passing.
        expect(runnerStage(text).length).toBeGreaterThan(200);
        expect(beforeRunner(text)).toMatch(/^RUN npm prune --omit=dev$/m);
    });

    it('declares a workspace, so the link this guards actually gets created', () => {
        // If `workspaces` is ever dropped, npm creates no link and this guard is
        // guarding a thing that cannot happen — worth knowing rather than
        // passing vacuously.
        const pkg = JSON.parse(
            fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
        ) as { workspaces?: string[] };
        expect(pkg.workspaces).toEqual(['packages/*']);
    });

    it('either removes the link before the runner stage, or ships packages/ into it', () => {
        const removesLink = WORKSPACE_LINK.test(beforeRunner(text));
        const shipsPackages = SHIPS_PACKAGES.test(runnerStage(text));

        // Both remedies are acceptable; neither is not. The message names the
        // two ways out so whoever hits this does not have to find them.
        expect({ removesLink, shipsPackages }).not.toEqual({
            removesLink: false,
            shipsPackages: false,
        });
    });

    it('the readers discriminate — mutation proof on SYNTHETIC input', () => {
        // Deliberately NOT a mutation of the live Dockerfile. An earlier draft
        // did that, and it reddened when the invariant was satisfied the OTHER
        // way (ship `packages/` instead of removing the link) — a guard that
        // fails on a legitimate remedy is one people route around, which is the
        // thing this file's either/or exists to prevent. Synthetic fixtures keep
        // the proof independent of which remedy happens to be live.
        const base = [
            'FROM node:24-alpine AS builder',
            'RUN npm prune --omit=dev',
            '# a comment mentioning rm -rf node_modules/@inflect must NOT count',
            'FROM node:24-alpine AS runner',
            'COPY --from=builder /app/public ./public',
            'COPY --from=builder /app/node_modules ./node_modules',
            '# COPY --from=builder /app/packages ./packages  (commented out)',
        ].join('\n');

        // Neither remedy: both readers must read false. This is the fixture that
        // proves the comment-masking works — `base` names both remedies in
        // comments and satisfies neither.
        expect(WORKSPACE_LINK.test(beforeRunner(base))).toBe(false);
        expect(SHIPS_PACKAGES.test(runnerStage(base))).toBe(false);

        // Remedy A: the link is removed before the runner stage.
        const removed = base.replace(
            'RUN npm prune --omit=dev',
            'RUN npm prune --omit=dev\nRUN rm -f node_modules/@inflect/ui',
        );
        expect(WORKSPACE_LINK.test(beforeRunner(removed))).toBe(true);

        // Remedy B: `packages/` is shipped into the runner instead.
        const shipped = base.replace(
            'COPY --from=builder /app/public ./public',
            'COPY --from=builder /app/packages ./packages\nCOPY --from=builder /app/public ./public',
        );
        expect(SHIPS_PACKAGES.test(runnerStage(shipped))).toBe(true);

        // And a removal that lands AFTER the runner stage does not count, because
        // the runner copies node_modules from the builder.
        const tooLate = base.replace(
            'COPY --from=builder /app/node_modules ./node_modules',
            'COPY --from=builder /app/node_modules ./node_modules\nRUN rm -f node_modules/@inflect/ui',
        );
        expect(WORKSPACE_LINK.test(beforeRunner(tooLate))).toBe(false);
    });
});
