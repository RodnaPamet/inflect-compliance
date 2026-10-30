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
        expect(reads.filter((r) => !['view.appliedAtIso', 'view.configDigest'].includes(r))).toEqual([]);
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
