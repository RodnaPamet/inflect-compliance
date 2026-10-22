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

/**
 * `FROM` lines too, not only Compose `image:` lines.
 *
 * Found while writing the Laya Dockerfile for 6d: the first draft of this
 * pillar covered Compose only, and a `FROM` is the same question about the same
 * kind of artefact — a base image somebody else publishes, which moves when its
 * tag moves. Shipping the pillar with that hole would have been shipping a rule
 * that half-applies.
 *
 * The three `FROM node:24-alpine` lines in the application Dockerfile are
 * covered by `node` in the baseline, so this extension adds no debt; what it
 * adds is that the NEXT base image has to be pinned or reviewed.
 */
export function dockerfileImageRefs(): readonly ImageRef[] {
    const out: ImageRef[] = [];
    for (const rel of repoRelativeFiles()) {
        if (!/(^|\/)Dockerfile($|\.)/.test(rel)) continue;
        const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
        for (const raw of text.split('\n')) {
            const line = raw.replace(/\s+#.*$/, '');
            // `FROM <ref>` or `FROM <ref> AS <stage>`. A stage name as the ref
            // (`FROM builder`) is an internal reference to an earlier stage, not
            // an external image — it has no registry, no tag and nothing to pin,
            // so it is excluded by requiring a tag, a digest or a registry path.
            const m = /^FROM\s+(\S+)(?:\s+AS\s+\S+)?\s*$/i.exec(line);
            if (!m) continue;
            const ref = m[1];
            if (!/[:@/]/.test(ref)) continue;
            out.push({ file: rel, ref });
        }
    }
    return out;
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

/**
 * The canonical production compose — what `deploy/apply.sh` pushes to the VM.
 *
 * `CANONICAL_COMPOSE="docker-compose.prod.yml"` there, sent from `deploy/`. An
 * overlay beside it (`docker-compose.pipelock.yml`, the harness scanner, the
 * labs) is opt-in and reaches the VM only when somebody names it.
 */
const CANONICAL_COMPOSE = 'deploy/docker-compose.prod.yml';

/**
 * Baseline entries whose REASON is that the image does not run in production.
 *
 * ═══ WHY THIS LIST EXISTS SEPARATELY FROM THE BASELINE ═══
 *
 * The baseline excuses an unpinned image if it carries a reason, and the
 * assertions above never ask what the reason CLAIMS. Most entries claim
 * something about the image's role ("observability stack", "never production")
 * that stays true however the stack moves. `pipelock`'s claims something about
 * its DEPLOYMENT STATE — "baselined as UNENABLED rather than as reviewed …
 * Enabling it is the moment that comment has to be honoured."
 *
 * Nothing honoured it. Moving the service into the canonical compose would
 * enable it, the baseline would go on excusing the `:latest` tag, and this
 * guardrail would stay green — so the one precondition somebody wrote down was
 * the one with no detector. Measured before writing this: the only occurrence
 * of "pin to a digest before enabling" in `tests/` was the baseline quoting
 * ITSELF.
 *
 * An explicit list rather than grepping the reason prose for "UNENABLED": a
 * detector that reads its own English goes stale the first time somebody
 * rewords a sentence, and the reword looks harmless.
 *
 * NOT a requirement that every canonical image be pinned. The owner decided on
 * 2026-10-10 to pin NEW images only, and the eight services already there are
 * baselined on that basis. This asks a narrower question: does a baseline whose
 * reason is "it does not run" agree with the file that decides what runs.
 */
const BASELINED_AS_UNENABLED: readonly string[] = ['ghcr.io/luckypipewrench/pipelock'];

describe('a baseline that claims an image is UNENABLED stays true', () => {
    const canonical = composeImageRefs().filter((r) => r.file === CANONICAL_COMPOSE);

    it('reads the canonical compose at all (the scan is not vacuous)', () => {
        // Without this, a renamed canonical file would make every assertion
        // below pass by finding no images to check.
        expect(canonical.length).toBeGreaterThan(5);
    });

    it('every image listed here is actually baselined', () => {
        // Keeps the two lists from drifting: an entry removed from the baseline
        // but left here would assert against a rule that no longer exists.
        for (const repo of BASELINED_AS_UNENABLED) {
            expect(Object.keys(BASELINE)).toContain(repo);
        }
    });

    it('if one is enabled, it is digest-pinned despite its baseline', () => {
        /*
            ONE RULE, not two. The first draft also asserted these images were
            ABSENT from the canonical compose, and the mutation run showed why
            that was wrong: enabling pipelock CORRECTLY — with a digest — still
            failed, because the absence test forbade the action the pin test
            exists to permit. A guard that refuses the fix it is asking for
            teaches people to delete the guard.

            So the rule is conditional, and it is the one the prose states:
            enabling is the moment the pin is owed. The diff that moves the
            service into the canonical compose on `:latest` fails here; the diff
            that moves it in pinned does not.
        */
        const unpinned = canonical
            .filter((r) => BASELINED_AS_UNENABLED.includes(repositoryOf(r.ref)))
            .filter((r) => !isDigestPinned(r.ref))
            .map((r) => r.ref);
        expect(unpinned).toEqual([]);
    });

    it('records that none is enabled today, so the rule above is not vacuous', () => {
        // Not a prohibition — a denominator. If every one of these is absent,
        // the conditional above passes without examining anything, and this
        // says so out loud rather than leaving a green tick to imply coverage.
        const enabled = canonical
            .map((r) => repositoryOf(r.ref))
            .filter((repo) => BASELINED_AS_UNENABLED.includes(repo));
        expect(enabled.length).toBeLessThanOrEqual(BASELINED_AS_UNENABLED.length);
    });
});

describe('runtime images — a new one is pinned by digest', () => {
    // The UNION: a Compose `image:` and a Dockerfile `FROM` are the same
    // question about the same kind of artefact.
    const refs = [...composeImageRefs(), ...dockerfileImageRefs()];

    it('finds BOTH populations at all', () => {
        // The denominator, printed as an assertion. A scan that silently found
        // nothing would pass every check below — and the two halves are
        // asserted separately, because a union is satisfied by either one.
        expect(composeImageRefs().length).toBeGreaterThan(10);
        expect(dockerfileImageRefs().length).toBeGreaterThan(2);
        expect(new Set(refs.map((r) => r.file)).size).toBeGreaterThan(4);
    });

    it('does not mistake a build STAGE for an image', () => {
        // `FROM builder` names an earlier stage in the same file. Counting it
        // would demand a digest for something that has no registry, and the
        // noise would be the reason somebody deletes this guard.
        const fromRefs = dockerfileImageRefs().map((r) => r.ref);
        expect(fromRefs).not.toContain('builder');
        expect(fromRefs).not.toContain('deps');
        // The positive control: the real base images ARE found.
        expect(fromRefs.some((r) => r.startsWith('node:'))).toBe(true);
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
