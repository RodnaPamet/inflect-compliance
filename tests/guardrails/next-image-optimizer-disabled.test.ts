/**
 * `/_next/image` stays off.
 *
 * ═══ WHY ═══
 *
 * The optimizer route fetches a same-origin URL and runs the bytes through
 * Next's VENDORED copy of `image-size`
 * (`node_modules/next/dist/compiled/image-size`), which carries the ICNS, JXL
 * and HEIF parsers covered by GHSA-w3rx-r6r6-pgpr and GHSA-5p2g-fcmc-qvqq —
 * two HIGH denial-of-service advisories for which no fixed release exists:
 * `image-size@2.0.2` is simultaneously the newest published version and inside
 * the vulnerable range `<= 2.0.2`.
 *
 * ═══ WHY NEITHER SCANNER SEES IT ═══
 *
 * That copy is bundled into Next's own dist rather than resolved through the
 * lockfile, so `npm audit` and Dependabot are both blind to it — they see only
 * the `pptxgenjs -> image-size` edge, which is the one
 * `security/audit-allowlist.json` covers and which is genuinely unreachable
 * (pptxgenjs never loads the package; see
 * tests/unit/pptx-image-size-unreachable.test.ts).
 *
 * This one was NOT unreachable. Measured in production on 2026-09-05, before
 * the flag: `/_next/image?url=%2Ffavicon.ico&w=64&q=75` answered 200, and
 * `src/middleware.ts` excludes `_next/image` from its matcher, so the route
 * took traffic without authentication or rate limiting.
 *
 * ═══ WHY TURNING IT OFF IS FREE ═══
 *
 * This codebase renders ZERO `<Image>` components. Every image site
 * deliberately uses a plain `<img>`, each carrying a written eslint-disable
 * explaining why next/image does not fit — runtime tenant-scoped `/api`
 * download URLs, blob previews, unknown dimensions. The optimizer was pure
 * attack surface with no consumer.
 *
 * The second assertion below pins that precondition, so the day someone adds
 * next/image this test tells them what removing the flag would cost.
 */
import fs from 'node:fs';
import path from 'node:path';
import { repoRelativeFiles, REPO_ROOT } from '../helpers/repo-files';
import { codeOf } from '../helpers/source-blocks';

const CONFIG = path.join(REPO_ROOT, 'next.config.js');

describe('the Next image optimizer is disabled', () => {
    it('next.config.js sets images.unoptimized', () => {
        // Asserted on the RESOLVED config rather than on the source text: the
        // file composes plugins (next-intl, bundle-analyzer) and a source-level
        // regex would pass on the flag appearing anywhere, including inside
        // the docblock that explains it.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const raw = require(CONFIG) as unknown;
        const resolved = (typeof raw === 'function' ? (raw as () => unknown)() : raw) as {
            default?: { images?: { unoptimized?: boolean } };
            images?: { unoptimized?: boolean };
        };
        const config = resolved.default ?? resolved;
        expect(config.images?.unoptimized).toBe(true);
    });

    it('nothing imports next/image — the precondition that makes this free', () => {
        // If this fails, someone has adopted next/image and the flag above is
        // now breaking their component rather than costing nothing. That is a
        // real decision to make, not a test to delete: removing the flag
        // re-opens an unauthenticated path into a known-vulnerable parser with
        // no upstream fix available. Weigh it, write down the reasoning, and
        // if you proceed, gate the route in middleware instead.
        const importers = repoRelativeFiles()
            .filter((rel) => rel.startsWith('src/') && /\.(ts|tsx)$/.test(rel))
            .filter((rel) => {
                const src = codeOf(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
                return /from\s+['"]next\/image['"]/.test(src);
            });
        expect(importers).toEqual([]);
    });

    it('the vendored copy really does carry the vulnerable parsers (not vacuous)', () => {
        // Grounds the whole file. If Next ever drops or replaces its vendored
        // image-size, this fails and the rationale above needs rewriting —
        // possibly the flag is no longer needed at all.
        // Resolve the way Node does rather than assuming `node_modules` sits at
        // REPO_ROOT. A git worktree has no `node_modules` of its own — it
        // resolves upward to the primary clone — so joining REPO_ROOT produced a
        // path that exists only outside a worktree, and this guard false-failed
        // for anyone working in one while passing in CI's single checkout.
        // Same family as the `.claude/worktrees` population trap CLAUDE.md
        // records: a path built from an assumed root, not a resolved one.
        let vendored: string;
        try {
            vendored = require.resolve('next/dist/compiled/image-size/index.js', {
                paths: [REPO_ROOT],
            });
        } catch {
            // `require.resolve` THROWS when the module is gone, so the explanatory
            // message this guard exists to deliver has to live here rather than
            // behind an existsSync that can no longer be reached.
            throw new Error(
                'next no longer vendors image-size (resolved from ' +
                    `${REPO_ROOT}) — re-assess whether images.unoptimized is still required`,
            );
        }
        const src = fs.readFileSync(vendored, 'utf8').toLowerCase();
        expect(['icns', 'jxl', 'heif'].filter((fmt) => !src.includes(fmt))).toEqual([]);
    });
});
