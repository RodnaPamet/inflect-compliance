/**
 * The fifth governance pillar: a NEW runtime image is pinned by digest.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY A FIFTH PILLAR, AND WHY IT IS ABOUT IMAGES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The four pillars in `docs/dependency-governance.md` are all about the npm
 * tree — deterministic installs, strict peer resolution, framework coherence,
 * reviewed runtime risk per package — and each is enforced by a guard that
 * reads `package.json` or the lockfile.
 *
 * None of that reaches a container image. The questions a reviewer actually
 * needs answered about one — who publishes it, what is inside it, what happens
 * when it moves, who reviews a bump — had no home in that document and nothing
 * behind them. Step 6d is what surfaced it: adding a model-serving image is the
 * first time the stack would run a third party's container *in the path of
 * personal data*, and the step's hardening list asks for a digest pin that no
 * guard could have checked.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NEW IMAGES ONLY — WHICH IS A DECISION, NOT A COMPROMISE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Owner decision, 2026-10-10, over pinning everything now. Zero of the sixteen
 * images this repository references are digest-pinned today, so the alternative
 * was a PR that changes how Postgres, PgBouncer, Redis, ClamAV and Caddy get
 * updated — and one of the three `:latest` references is the application's own,
 * which is `:latest` BY DESIGN because Watchtower updates it.
 *
 * So every image that exists is baselined BY NAME with a reason, and the rule
 * binds the next one. The baseline is keyed on the repository rather than on
 * the full reference, which is the shape that makes "new images only" mean what
 * it says: `postgres:16-alpine` → `postgres:17-alpine` still passes, because a
 * tag bump on a known image is the status quo this decision deliberately left
 * alone, while `ghcr.io/anybody/anything` fails until it carries a digest or is
 * reviewed into the baseline.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE POPULATION COMES FROM GIT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `repoRelativeFiles()`, not a directory walk with a skip list. A hand-written
 * skip list is a denominator nothing checks, and this repo has already paid for
 * that once — `.claude/worktrees/<id>/` holds a full checkout, so a walker read
 * the repo's own copy of itself and reported it.
 *
 * @module guardrails/runtime-image-pinning
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { REPO_ROOT, repoRelativeFiles } from '../helpers/repo-files';

/**
 * Images referenced today, each with why it is not digest-pinned.
 *
 * Keyed on the REPOSITORY — everything before the final tag — so one entry
 * covers an image referenced from several files, and a tag bump does not need a
 * new one. Adding an entry here is a reviewed act: it says somebody looked at
 * what this image is and who publishes it.
 */
const BASELINE: Readonly<Record<string, string>> = {
    'ghcr.io/rodnapamet/inflect-compliance':
        'OUR OWN application image, and `:latest` is deliberate: Watchtower watches that tag '
        + 'and is the deploy mechanism. A digest here would stop deployments rather than '
        + 'secure them. Provenance is this repository and the GHCR org it publishes to.',
    postgres:
        'Docker Official Image. The production database, pinned to the 16 line; a digest pin '
        + 'would freeze security patches that the alpine tag delivers.',
    redis:
        'Docker Official Image, pinned to the 7 line. Same reasoning as postgres: a digest would '
        + 'freeze the security patches the alpine tag delivers.',
    caddy: 'Docker Official Image, pinned to the 2 line. Terminates TLS; no tenant data at rest.',
    mariadb: 'Docker Official Image. The OrangeHRM LAB only — never production.',
    'node': 'Docker Official Image. Build and test stages only.',
    'clamav/clamav':
        'Cisco-maintained, the upstream for the scanner itself. Pinned to the 1.4 line.',
    'edoburu/pgbouncer':
        'Community image for the connection pooler. Referenced twice, once as `:latest` in a '
        + 'non-production file — flagged for review in the issue, not fixed here, because '
        + 'this decision was explicitly scoped to new images.',
    'containrrr/watchtower':
        'The deploy mechanism itself, on `:latest`. Pinning it would freeze the component '
        + 'that performs updates.',
    'orangehrm/orangehrm': 'The vendor image for the HRIS LAB. Never production.',
    'grafana/grafana':
        'Observability stack, version-pinned. Reads metrics and traces; holds no tenant rows.',
    'grafana/tempo': 'Observability stack, version-pinned. Holds traces, never tenant rows.',
    'prom/prometheus': 'Observability stack, version-pinned. Scrapes metrics, never tenant rows.',
    'otel/opentelemetry-collector-contrib':
        'Observability stack, version-pinned. Forwards spans and metrics, never tenant rows.',
    'ghcr.io/luckypipewrench/pipelock':
        'A peer tool, outside the application stack, and its own compose line already says '
        + '"pin to a digest before enabling" — so it is baselined as UNENABLED rather than as '
        + 'reviewed. Enabling it is the moment that comment has to be honoured.',
};

/** Every `image:` reference in a compose file git tracks, with its file. */
interface ImageRef {
    readonly file: string;
    readonly ref: string;
}

export function composeImageRefs(): readonly ImageRef[] {
    const out: ImageRef[] = [];
    for (const rel of repoRelativeFiles()) {
        if (!/docker-compose.*\.ya?ml$/.test(rel)) continue;
        const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
        for (const raw of text.split('\n')) {
            // STRIP A TRAILING COMMENT FIRST. The first draft of this regex
            // required end-of-line after the reference, and
            // `deploy/docker-compose.pipelock.yml` carries
            // `image: … :latest # pin to a digest before enabling` — so the one
            // reference somebody had already flagged was the one the guard
            // could not see. A scan that silently drops what it cannot parse
            // reports full coverage of the subset it understands.
            const line = raw.replace(/\s+#.*$/, '');
            const m = /^\s*image:\s*(\S+)\s*$/.exec(line);
            if (m) out.push({ file: rel, ref: m[1] });
        }
    }
    return out;
}

/** Digest-pinned? `repo@sha256:…`, with or without a tag before the digest. */
export function isDigestPinned(ref: string): boolean {
    return /@sha256:[0-9a-f]{64}$/.test(ref);
}

/**
 * The repository part of a reference — what the baseline is keyed on.
 *
 * The last `:` separates the tag, EXCEPT when it is part of a registry
 * host:port. A colon after the last `/` is a tag; one before it is a port.
 */
export function repositoryOf(ref: string): string {
    const withoutDigest = ref.split('@')[0];
    const lastSlash = withoutDigest.lastIndexOf('/');
    const lastColon = withoutDigest.lastIndexOf(':');
    return lastColon > lastSlash ? withoutDigest.slice(0, lastColon) : withoutDigest;
}

describe('runtime images — a new one is pinned by digest', () => {
    const refs = composeImageRefs();

    it('finds the compose population at all', () => {
        // The denominator, printed as an assertion. A scan that silently found
        // nothing would pass every check below.
        expect(refs.length).toBeGreaterThan(10);
        expect(new Set(refs.map((r) => r.file)).size).toBeGreaterThan(3);
    });

    it('every image is digest-pinned OR baselined with a reason', () => {
        const unexplained = refs
            .filter((r) => !isDigestPinned(r.ref) && !(repositoryOf(r.ref) in BASELINE))
            .map((r) => `${r.file}: ${r.ref}`);

        expect(unexplained).toEqual([]);
    });

    it('every baseline entry carries a real reason', () => {
        for (const [image, reason] of Object.entries(BASELINE)) {
            expect(reason.trim().length).toBeGreaterThan(40);
            expect(`${image} ${reason}`).not.toMatch(/\bTODO\b/);
        }
    });

    it('no baseline entry is stale', () => {
        // The convention every exempt map in this repo follows: when an image
        // is removed or finally pinned, its entry goes in the same diff.
        const present = new Set(refs.map((r) => repositoryOf(r.ref)));
        const stale = Object.keys(BASELINE).filter((image) => !present.has(image));
        expect(stale).toEqual([]);
    });

    describe('detector proof — on synthetic references, so a clean run means something', () => {
        it('reads a digest pin as pinned', () => {
            expect(isDigestPinned(`repo/img@sha256:${'a'.repeat(64)}`)).toBe(true);
            expect(isDigestPinned(`repo/img:1.2@sha256:${'b'.repeat(64)}`)).toBe(true);
        });

        it('reads a tag as NOT pinned', () => {
            expect(isDigestPinned('repo/img:1.2')).toBe(false);
            expect(isDigestPinned('repo/img:latest')).toBe(false);
            expect(isDigestPinned('repo/img')).toBe(false);
            // A truncated digest is not a digest. Without this the regex could
            // be loosened to `@sha256:` and nobody would notice.
            expect(isDigestPinned('repo/img@sha256:abc')).toBe(false);
        });

        it('separates a tag from a registry PORT', () => {
            // The case that makes a naive `split(':')[0]` wrong, and it is not
            // hypothetical — a private registry on a port is the normal shape.
            expect(repositoryOf('registry.example:5000/img')).toBe('registry.example:5000/img');
            expect(repositoryOf('registry.example:5000/img:1.2')).toBe(
                'registry.example:5000/img',
            );
            expect(repositoryOf('postgres:16-alpine')).toBe('postgres');
            expect(repositoryOf('ghcr.io/org/img:latest')).toBe('ghcr.io/org/img');
        });

        it('still reads a reference that carries a trailing COMMENT', () => {
            // The miss the first draft had. Asserted on the real file rather
            // than on a synthetic line, because the point is that this
            // reference is in the population.
            const refs2 = composeImageRefs();
            expect(refs2.some((r) => r.ref.includes('pipelock'))).toBe(true);
            // And no captured reference carries a comment fragment.
            for (const r of refs2) expect(r.ref).not.toContain('#');
        });

        it('flags a NEW unpinned image, which is the whole point', () => {
            const invented = 'ghcr.io/somebody/model-server:latest';
            expect(isDigestPinned(invented)).toBe(false);
            expect(repositoryOf(invented) in BASELINE).toBe(false);
        });

        it('accepts that same new image once it carries a digest', () => {
            const pinned = `ghcr.io/somebody/model-server@sha256:${'c'.repeat(64)}`;
            expect(isDigestPinned(pinned)).toBe(true);
        });
    });
});
