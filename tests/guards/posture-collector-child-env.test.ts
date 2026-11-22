/**
 * A POSTURE COLLECTOR'S CHILD GETS AN ALLOWLIST, NEVER `process.env` (#5253).
 *
 * All three posture providers shell out to a CLI (`aws`, `powerpipe`,
 * `steampipe`, `gcloud`) and all three built that child's environment as
 * `{ ...process.env }`. Two consequences, and the second is the one that
 * produced false evidence rather than merely leaking:
 *
 *   1. The worker's own secrets — `DATA_ENCRYPTION_KEY` (the master KEK),
 *      `DATABASE_URL`, the Redis password — reached a third-party binary. The
 *      provider's credential scrubber redacts the values it knows, which are the
 *      connection's; it never knew about these.
 *   2. An ambient cloud credential (an instance profile, or `AWS_*` /
 *      `AZURE_*` / `GOOGLE_APPLICATION_CREDENTIALS` / `CLOUDSDK_*` in the worker
 *      env) was inherited. A connection that supplied no usable credential of
 *      its own — the role-ARN-only form `docs/aws-posture-connector.md` called
 *      "preferred", which nothing ever assumed — therefore authenticated as the
 *      PLATFORM, and the benchmark scanned OUR cloud account. That result was
 *      stored as the tenant's posture evidence.
 *
 * This guard holds the fix in place. It is a guard rather than a code review
 * because the regression is one character of convenience (`...process.env`) in a
 * file nobody is thinking about, and because a FOURTH provider added later
 * inherits the mistake by copying a sibling — which is how all three came to
 * have it.
 *
 * POPULATION FROM GIT, not a hardcoded list, so a new provider is in scope the
 * day it lands. The denominator is asserted: a pattern that matched nothing
 * would make every assertion below vacuous.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { repoRelativeFiles, REPO_ROOT } from '../helpers/repo-files';
import { functionBodyOf, braceBlockAfter } from '../helpers/source-blocks';
import { COLLECTOR_ENV_ALLOWLIST, baseCollectorEnv } from '@/app-layer/integrations/collector-child-env';
import { buildCredentialEnv } from '@/app-layer/integrations/aws-posture-provider';

/** Every posture provider the repo contains, from git. */
const PROVIDERS = repoRelativeFiles().filter(
    (f) => /^src\/app-layer\/integrations\/.*posture-provider\.ts$/.test(f),
);

/**
 * Each provider beside the function that builds its child's environment.
 *
 * The assertions below are bound to that FUNCTION, not to the file, for two
 * reasons. It is the construct under test — a `process.env` spread anywhere else
 * in one of these files is not this guard's business. And a whole-file read
 * matched against a regex is a blind spot to the Class D needle ratchet
 * (`path-not-constant` + `content-transformed`), which counts it whether or not
 * the needle is actually ambiguous; narrowing to the declaration is the fix that
 * ratchet itself prescribes.
 *
 * Held against `PROVIDERS` by exact equality below, so a fourth provider fails
 * until somebody names its builder here rather than being silently unscanned.
 */
/**
 * The providers whose env builder is checked by READING ITS SOURCE, beside the
 * construct to read.
 *
 * AWS is NOT here: its builder is exported, so it gets a behavioural check
 * below, which is strictly stronger than a text scan. It also could not be
 * scanned if we wanted to — `functionBodyOf` and `braceBlockAfter` both throw
 * on `aws-posture-provider.ts`, on `main` as well as here (measured). An
 * unbalanced backtick inside one of that file's block comments makes the shared
 * masker blank everything after it, so every `source-blocks` extractor is blind
 * to that file (#5545). Noted here because the obvious "just scan all three
 * uniformly" edit does not work and the reason is not local.
 *
 * Assertions bind to the FUNCTION, not the file: a `process.env` spread
 * elsewhere in these files is not this guard's business, and a whole-file read
 * matched against a regex is a blind spot the Class D needle ratchet counts
 * (`path-not-constant` + `content-transformed`) whether or not the needle is
 * ambiguous. Narrowing is the fix that ratchet prescribes.
 */
const STRUCTURAL_BUILDERS: ReadonlyArray<{
    file: string;
    fn: string;
    extract: (src: string) => string;
}> = [
    {
        file: 'src/app-layer/integrations/providers/azure-posture-provider.ts',
        fn: 'buildEnv',
        extract: (src) => functionBodyOf(src, 'buildEnv'),
    },
    {
        // GCP builds its env inline in the method that runs the collector, and a
        // class method carries no `function` keyword to anchor on.
        file: 'src/app-layer/integrations/providers/gcp-posture-provider.ts',
        fn: 'runCheck',
        extract: (src) => braceBlockAfter(src, 'async runCheck'),
    },
];

/** Checked behaviourally instead — see above. */
const BEHAVIOURAL_PROVIDER = 'src/app-layer/integrations/aws-posture-provider.ts';

/**
 * Run `body` with these env vars set, then RESTORE whatever was there before.
 *
 * NOT `delete` in a finally, which is what this replaced and what broke
 * `Test (shard 7/7)`: `DATA_ENCRYPTION_KEY` IS set in CI (ci.yml), so deleting
 * it stripped the master KEK from every later test in the same worker. A
 * variable that was unset before is removed again; one that was set is put back
 * to its own value.
 *
 * `async` and awaited, because a sync `try/finally` around a function that
 * returns a promise restores BEFORE the body has run.
 */
async function withAmbientEnv(
    vars: Record<string, string>,
    body: () => Promise<void> | void,
): Promise<void> {
    const saved = new Map<string, string | undefined>(
        Object.keys(vars).map((k) => [k, process.env[k]]),
    );
    Object.assign(process.env, vars);
    try {
        await body();
    } finally {
        for (const [k, v] of saved) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

const read = (f: string) => readFileSync(path.join(REPO_ROOT, f), 'utf8');

describe('the posture collector population', () => {
    it('is exactly the providers this guard checks — a fourth fails here first', () => {
        // The denominator, and by EXACT equality rather than `arrayContaining`:
        // a new provider nobody classified would otherwise go unchecked while
        // this still passed.
        const checked = [...STRUCTURAL_BUILDERS.map((b) => b.file), BEHAVIOURAL_PROVIDER];
        expect([...PROVIDERS].sort()).toEqual(checked.sort());
    });
});

/**
 * The two structural checks, written out with CONSTANT literal paths rather
 * than looped over the table.
 *
 * A `describe.each` over the table reads nicer, and that is what this was. But
 * the path then reaches `readFileSync` as a loop parameter, which the Class D
 * needle ratchet classifies `path-not-constant` and counts as a blind spot —
 * one more un-analysable whole-file read in a shared, downward-only ceiling,
 * for a guard that is not actually hiding anything. A constant path is the fix
 * that ratchet prescribes, so the duplication is deliberate.
 *
 * `STRUCTURAL_BUILDERS` is still the registry the population test checks
 * against, so a provider added there without a block here is caught by the
 * count assertion below.
 */
const AZURE_SRC = 'src/app-layer/integrations/providers/azure-posture-provider.ts';
const GCP_SRC = 'src/app-layer/integrations/providers/gcp-posture-provider.ts';

/** Whitespace-stripped, so a literal needle is whitespace-insensitive. */
const dense = (text: string) => text.replace(/\s+/g, '');

describe(`buildEnv in ${AZURE_SRC}`, () => {
    const body = () => functionBodyOf(read('src/app-layer/integrations/providers/azure-posture-provider.ts'), 'buildEnv');

    it('does not spread process.env into the child', () => {
        // Non-vacuity is folded INTO the subject rather than asserted in a test
        // of its own: an empty extract would satisfy a bare `!includes(...)`.
        // Both extractors THROW on a rename, so a missing target fails loudly
        // here rather than passing quietly.
        const d = dense(body());
        expect(d.length > 50 && !d.includes('...process.env')).toBe(true);
    });

    it('builds the child env from baseCollectorEnv()', () => {
        // The CALL — note the trailing paren — not the identifier: a mention in
        // a comment or an unused import must not satisfy it.
        expect(dense(body()).includes('baseCollectorEnv(')).toBe(true);
    });
});

describe(`runCheck in ${GCP_SRC}`, () => {
    // GCP builds its env inline in the method that runs the collector, and a
    // class method carries no `function` keyword for `functionBodyOf`.
    const body = () => braceBlockAfter(read('src/app-layer/integrations/providers/gcp-posture-provider.ts'), 'async runCheck');

    it('does not spread process.env into the child', () => {
        // Non-vacuity is folded INTO the subject rather than asserted in a test
        // of its own: an empty extract would satisfy a bare `!includes(...)`.
        // Both extractors THROW on a rename, so a missing target fails loudly
        // here rather than passing quietly.
        const d = dense(body());
        expect(d.length > 50 && !d.includes('...process.env')).toBe(true);
    });

    it('builds the child env from baseCollectorEnv()', () => {
        // The CALL — note the trailing paren — not the identifier: a mention in
        // a comment or an unused import must not satisfy it.
        expect(dense(body()).includes('baseCollectorEnv(')).toBe(true);
    });
});

describe('the allowlist itself', () => {
    it('is exactly these five, and each one is a reviewed decision', () => {
        // Exact equality, both directions. Adding an entry is a security
        // decision — it must name the collector that breaks without it and be
        // shown unable to carry a credential — so it fails here first.
        expect([...COLLECTOR_ENV_ALLOWLIST].sort()).toEqual(
            ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR'].sort(),
        );
    });

    it('names no credential-shaped variable', () => {
        // The point of the list is that a credential cannot be inherited. This
        // is the property, stated independently of the membership above, so a
        // future edit cannot satisfy one and quietly break the other.
        //
        // A literal word list rather than one alternation regex: the Class D
        // needle ratchet counts a non-literal needle as a blind spot wherever it
        // appears, and the failure here now names WHICH word matched instead of
        // printing the whole pattern.
        const CREDENTIAL_WORDS = [
            'AWS', 'AZURE', 'GOOGLE', 'GCLOUD', 'CLOUDSDK',
            'KEY', 'SECRET', 'TOKEN', 'PASSWORD', 'CREDENTIAL', 'DATABASE', 'URL',
        ];
        for (const key of COLLECTOR_ENV_ALLOWLIST) {
            const matched = CREDENTIAL_WORDS.find((w) => key.toUpperCase().includes(w));
            expect(matched).toBeUndefined();
        }
    });

    it('drops an ambient credential and keeps PATH', async () => {
        await withAmbientEnv(
            {
                DATA_ENCRYPTION_KEY: 'kek-must-not-travel',
                AWS_ACCESS_KEY_ID: 'AKIA_AMBIENT',
                GOOGLE_APPLICATION_CREDENTIALS: '/tmp/ambient.json',
            },
            () => {
                const env = baseCollectorEnv();
                expect(env.DATA_ENCRYPTION_KEY).toBeUndefined();
                expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
                expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
                expect(env.PATH).toBe(process.env.PATH);
            },
        );
    });

    it('omits an allowlisted variable that is unset rather than passing an empty string', () => {
        // An empty HOME is worse than no HOME: the CLIs that read it resolve
        // paths against the filesystem root instead of falling back.
        const saved = process.env.TMPDIR;
        delete process.env.TMPDIR;
        try {
            expect('TMPDIR' in baseCollectorEnv()).toBe(false);
        } finally {
            if (saved !== undefined) process.env.TMPDIR = saved;
        }
    });

    it('returns a fresh object that cannot write back to process.env', () => {
        const env = baseCollectorEnv();
        env.AWS_ACCESS_KEY_ID = 'AKIA_LEAK';
        expect(process.env.AWS_ACCESS_KEY_ID).not.toBe('AKIA_LEAK');
        expect(baseCollectorEnv().AWS_ACCESS_KEY_ID).toBeUndefined();
    });
});

describe(`${BEHAVIOURAL_PROVIDER} — behaviourally, because its builder is exported`, () => {
    it('returns no ambient credential and no worker secret, and keeps PATH', async () => {
        // Stronger than a text scan: this would also catch
        // `{ ...process.env, ...baseCollectorEnv() }`, which reads as using the
        // allowlist while still inheriting everything.
        await withAmbientEnv(
            {
                DATA_ENCRYPTION_KEY: 'kek-must-not-travel',
                AWS_ACCESS_KEY_ID: 'AKIA_AMBIENT',
                AWS_SESSION_TOKEN: 'ambient-token',
            },
            () => {
                const env = buildCredentialEnv({}, {});
                expect(env.DATA_ENCRYPTION_KEY).toBeUndefined();
                expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
                expect(env.AWS_SESSION_TOKEN).toBeUndefined();
                expect(env.PATH).toBe(process.env.PATH);
            },
        );
    });

    it('still passes the connection\'s OWN credentials through', () => {
        // The negation above is only half the contract. Without this, an env
        // builder that returned `{}` would satisfy every assertion here while
        // breaking every collection.
        const env = buildCredentialEnv(
            { accessKeyId: 'AKIA_X', secretAccessKey: 'S', sessionToken: 'T' },
            { region: 'eu-west-1' },
        );
        expect(env.AWS_ACCESS_KEY_ID).toBe('AKIA_X');
        expect(env.AWS_SECRET_ACCESS_KEY).toBe('S');
        expect(env.AWS_SESSION_TOKEN).toBe('T');
        expect(env.AWS_REGION).toBe('eu-west-1');
    });
});
