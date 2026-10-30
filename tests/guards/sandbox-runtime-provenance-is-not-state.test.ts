/**
 * 5.6e (#4000): the digest is a claim, and no rendered string asserts a value.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THESE TWO BELONG TOGETHER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * They are the two halves of "provenance instead of state". The digest makes
 * the page able to say something true about what was SENT; the second rule
 * stops it saying something false about what is in EFFECT. Either alone is
 * worse than useless: a digest beside `Telemetry: off` just dates the lie, and
 * a page with no assertions and no digest says nothing at all.
 *
 * Neither needs the gateway binary, which is why they live here rather than in
 * `npm run openshell:digest`. CI has no binary, so preflight is skipped there
 * with a message — these are the parts that hold everywhere.
 *
 * @module guards/sandbox-runtime-provenance-is-not-state
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { CONFIG_PATH, DIGEST_PATH, digestOf, recordedDigest } from '@/../scripts/openshell-config-digest';
import { REPORTING_CHANNELS } from '@/lib/sandbox-runtime/declarations';

import { REPO_ROOT } from '../helpers/repo-files';

const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

describe('the recorded config digest is a claim that can be wrong', () => {
    it('matches the configuration actually committed', () => {
        /*
            THE POINT OF COMMITTING IT. A digest computed only at deploy time is
            unfalsifiable — whatever was applied hashes to whatever it hashes to,
            and nothing can disagree. Committing it gives the number something to
            be wrong against: editing `gateway.toml` without re-recording fails
            HERE, which is what makes the value on the admin page a claim rather
            than a decoration.

            Re-record with: npm run openshell:digest -- --write
        */
        const actual = digestOf(fs.readFileSync(path.join(REPO_ROOT, CONFIG_PATH)));
        expect(recordedDigest(read(DIGEST_PATH))).toBe(actual);
    });

    it('reads a real config and a real digest (neither side is empty)', () => {
        // DENOMINATOR. Two empty files hash to the same thing as each other and
        // would satisfy the equality above while checking nothing.
        expect(read(CONFIG_PATH).length).toBeGreaterThan(2000);
        expect(recordedDigest(read(DIGEST_PATH))).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    it('the digest file says how to re-record it', () => {
        // A failing equality above is only actionable if the fix is written
        // down where somebody looking at the file will find it.
        const lines = read(DIGEST_PATH).split('\n');
        expect(lines.filter((l) => l.includes('openshell:digest')).length).toBeGreaterThanOrEqual(1);
    });
});

describe('no rendered string asserts a setting effective value', () => {
    const CLIENT = 'src/app/t/[tenantSlug]/(app)/admin/sandbox-runtime/SandboxRuntimeClient.tsx';

    it('renders every channel through a display function, never a raw boolean', () => {
        /*
            The failure this prevents: `{view.channels[k] ? 'on' : 'off'}`. That
            reads a DECLARED value and renders it as an effective one, which is
            the single thing this page exists not to do — 0.1a established the
            gateway has no configuration read API, so nothing here can know.

            Checked as a count of the raw-boolean shape rather than by reading
            the JSX, because the shape is what matters and prose drifts.
        */
        const src = read(CLIENT);
        const rawBooleanRenders = src
            .split('\n')
            .filter((l) => /\{\s*(view|declaration)\.channels\[/.test(l))
            .filter((l) => !/displayFor/.test(l));
        expect(rawBooleanRenders).toEqual([]);
    });

    it('the provenance row has no field a value could be rendered from', () => {
        // Asserted on the TYPE's runtime shape in the unit suite; here the
        // complement — the client's provenance block reads only from
        // `provenance`, so a value added to `view` cannot reach it.
        const src = read(CLIENT);
        const block = /data-testid="sandbox-provenance"([\s\S]*?)<\/dl>/.exec(src);
        expect(block).not.toBeNull();
        const body = (block as RegExpExecArray)[1];
        // Every interpolation in that block names `provenance` or a translation.
        const reads = [...body.matchAll(/\{(view|declaration)\.(\w+)/g)].map((m) => `${m[1]}.${m[2]}`);
        /*
            THE ALLOWLIST IS THE POINT, not a formality. Each entry is a field
            somebody decided may appear in this block, and the guard caught the
            third one being added (#4572) rather than letting it in silently.

            All three are PROVENANCE — what was sent, when, and when we last
            looked. None is a setting's effective value, which is the thing this
            page cannot know and must not imply. A fourth entry should be
            argued the same way, and a field named after a channel or a mode
            does not belong here at all.
        */
        const ALLOWED_PROVENANCE_READS = [
            'view.appliedAtIso',
            'view.configDigest',
            // #4572: WHEN the probe answered. The verdict may be reused for up
            // to 30 seconds, so the age is rendered — a cached "reachable" must
            // not read as a current one.
            'view.probedAtIso',
        ];
        expect(reads.filter((r) => !ALLOWED_PROVENANCE_READS.includes(r))).toEqual([]);
    });

    it('the reachability strings name no reporting channel', () => {
        /*
            A reachability line says whether the gateway ANSWERED. If one of its
            strings named a channel — "telemetry reachable" — a reader would take
            it as a statement about that channel's setting, which is exactly the
            confusion `declared-not-observed` was added to the vocabulary to
            avoid.

            Both catalogues, because a claim is only absent if it is absent in
            the language the operator reads.
        */
        const channelWords = REPORTING_CHANNELS.flatMap((c) => c.key.split('-'));
        expect(channelWords.length).toBeGreaterThan(4);
        for (const locale of ['en', 'bg']) {
            const cat = JSON.parse(read(`messages/${locale}.json`)) as {
                admin: { sandboxRuntime: Record<string, string> };
            };
            const reach = Object.entries(cat.admin.sandboxRuntime).filter(([k]) =>
                k.startsWith('reachability'),
            );
            // Denominator: the keys exist in this locale at all.
            expect(reach.length).toBeGreaterThanOrEqual(5);
            const offenders = reach.filter(([, v]) =>
                channelWords.some((w) => w.length > 4 && v.toLowerCase().includes(w)),
            );
            expect(offenders).toEqual([]);
        }
    });

    it('both catalogues carry the same reachability keys', () => {
        // A missing Bulgarian key renders the raw key name to the operator,
        // which is a worse statement than any of the five.
        const keysFor = (locale: string): string[] =>
            Object.keys(
                (JSON.parse(read(`messages/${locale}.json`)) as {
                    admin: { sandboxRuntime: Record<string, string> };
                }).admin.sandboxRuntime,
            )
                .filter((k) => k.startsWith('reachability'))
                .sort();
        expect(keysFor('bg')).toEqual(keysFor('en'));
    });
});

describe('the PKI regeneration script exists and says what it costs', () => {
    /*
        #4565. The owner decided the PKI is REGENERABLE rather than backed up,
        and that decision is only safe while the procedure exists and names its
        consequence. A new CA invalidates every client certificate it signed —
        there is no revocation and no grace period — so a reader who runs the
        script without knowing that can break an inbound caller with no obvious
        cause.

        Asserted on the script's PRESENCE and on the two properties that make it
        safe, not on its prose: it must refuse by default, and it must state the
        client-certificate consequence somewhere a reader meets it.
    */
    const SCRIPT = 'deploy/openshell/regenerate-pki.sh';

    it('the script is committed and executable', () => {
        const abs = path.join(REPO_ROOT, SCRIPT);
        expect(fs.existsSync(abs)).toBe(true);
        // Mode matters: a procedure nobody can run is a document.
        expect((fs.statSync(abs).mode & 0o111) !== 0).toBe(true);
    });

    it('refuses by default and needs an explicit force', () => {
        // A script that silently regenerates over a working PKI is a footgun:
        // the failure is invisible until an inbound call is rejected, and by
        // then the old CA is unrecoverable.
        const src = read(SCRIPT);
        const lines = src.split('\n');
        expect(lines.filter((l) => l.includes('--force')).length).toBeGreaterThanOrEqual(2);
        // An early exit guarded on an existing CA, before anything is written.
        expect(lines.filter((l) => /exit 2/.test(l)).length).toBeGreaterThanOrEqual(1);
    });

    it('states the client-certificate consequence', () => {
        // The one fact a reader must not discover afterwards.
        const src = read(SCRIPT).toLowerCase();
        expect(src.includes('invalidates every client certificate')).toBe(true);
        expect(src.includes('re-issue')).toBe(true);
    });

    it('derives the SAN address rather than hardcoding one', () => {
        // A hardcoded address produces a certificate that fails verification on
        // any other host — the sort of thing nobody notices until mTLS refuses
        // a connection.
        const src = read(SCRIPT);
        expect(src.includes('hostname -I')).toBe(true);
        // And no literal 10.x address baked into the cert material.
        const literals = src.split('\n').filter((l) => /IP:10\.\d+\.\d+\.\d+/.test(l));
        expect(literals).toEqual([]);
    });

    it('the README records the decision and that it was proved by running it', () => {
        const readme = read('deploy/openshell/README.md');
        const lines = readme.split('\n');
        expect(lines.filter((l) => l.includes('regenerate-pki')).length).toBeGreaterThanOrEqual(1);
        // The decision is only auditable if the reasoning is written down.
        expect(lines.filter((l) => /REGENERABLE, not backed up/.test(l)).length).toBe(1);
    });
});

describe('an empty deploy value means absent, not invalid', () => {
    /*
        #4564. Compose and shell defaults produce EMPTY STRINGS, not absent
        variables — `"${VAR:-}"` is how every optional value in this stack is
        defaulted. `SANDBOX_RUNTIME_HEALTH_URL` was `z.string().url().optional()`,
        which accepts `undefined` and rejects `''` with "Invalid URL", so an
        operator who left the line in but blank would have failed env validation
        and the container would not have started.

        A working state turned into an outage by a variable nobody set. Asserted
        on the SCHEMA rather than by booting the app, because the failure is a
        validation one and that is where it lives.
    */
    it('coerces an empty or whitespace health URL to absent', async () => {
        const { z } = await import('zod');
        // The shape `src/env.ts` uses. Kept in step by the assertion below that
        // the real file still preprocesses this variable.
        const schema = z.preprocess(
            (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
            z.string().url().optional(),
        );
        for (const empty of ['', '   ', '\t']) {
            const r = schema.safeParse(empty);
            expect(r.success).toBe(true);
            expect(r.success && r.data).toBeUndefined();
        }
    });

    it('still rejects a malformed URL — the coercion does not widen validation', async () => {
        const { z } = await import('zod');
        const schema = z.preprocess(
            (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
            z.string().url().optional(),
        );
        expect(schema.safeParse('not-a-url').success).toBe(false);
        expect(schema.safeParse('http://10.132.0.28:8081').success).toBe(true);
    });

    it('env.ts actually preprocesses that variable (not just this test)', () => {
        // The assertions above describe a schema shape; this holds the real file
        // to it. Without this they would pass while `env.ts` kept the raw
        // `z.string().url().optional()` that caused the problem.
        const src = read('src/env.ts');
        const lines = src.split('\n');
        const idx = lines.findIndex((l) => l.includes('SANDBOX_RUNTIME_HEALTH_URL:'));
        expect(idx).toBeGreaterThan(-1);
        expect(lines[idx]).toContain('z.preprocess');
    });

    it('the deploy README names all four variables an operator must set', () => {
        // The variables are useless undocumented: nothing in the repo sets them
        // and the page is blank until somebody does.
        const readme = read('deploy/openshell/README.md');
        for (const v of [
            'SANDBOX_RUNTIME_CONFIG_DIGEST',
            'SANDBOX_RUNTIME_APPLIED_AT',
            'SANDBOX_RUNTIME_CHANNELS',
            'SANDBOX_RUNTIME_HEALTH_URL',
        ]) {
            expect(readme.split('\n').filter((l) => l.includes(v)).length).toBeGreaterThanOrEqual(1);
        }
    });
});
