/**
 * Coverage wave E batch 2 — pure helpers of
 * `src/app-layer/integrations/aws-posture-provider.ts`.
 *
 * These five exports carry the provider's branch weight and need no I/O:
 * the Powerpipe JSON walk + status aggregation, the credential scrubber, the
 * bounded result summariser, and the child-process credential env.
 *
 * Two of them are security-load-bearing and are asserted as such:
 *   • `scrubAwsCredentials` — anything logged or persisted from a CLI run goes
 *     through it, so a missed key pattern is a credential leak.
 *   • `buildCredentialEnv` — credentials must travel via env, NEVER argv
 *     (argv is world-readable via /proc on most hosts).
 */
import {
    shortControlName,
    parsePowerpipeBenchmarkJson,
    scrubAwsCredentials,
    summariseBenchmark,
    buildCredentialEnv,
    RESULT_JSON_MAX_BYTES,
} from '@/app-layer/integrations/aws-posture-provider';

describe('shortControlName', () => {
    it('strips everything up to and including the .control. marker', () => {
        expect(
            shortControlName('aws_compliance.control.iam_root_user_mfa_enabled'),
        ).toBe('iam_root_user_mfa_enabled');
    });

    it('falls back to the last dotted segment', () => {
        expect(shortControlName('some.other.path')).toBe('path');
    });

    it('returns the input when there is nothing to strip', () => {
        expect(shortControlName('bare')).toBe('bare');
    });

    it('returns the original when the split yields an empty tail', () => {
        expect(shortControlName('trailing.')).toBe('trailing.');
    });
});

describe('parsePowerpipeBenchmarkJson', () => {
    const control = (over: Record<string, unknown> = {}) => ({
        control_id: 'aws_compliance.control.c1',
        title: 'Root MFA',
        summary: { status: { ok: 1 } },
        ...over,
    });

    it('returns nothing for empty or absent input', () => {
        expect(parsePowerpipeBenchmarkJson(undefined)).toEqual([]);
        expect(parsePowerpipeBenchmarkJson({})).toEqual([]);
    });

    it('flattens controls at the root', () => {
        expect(parsePowerpipeBenchmarkJson({ controls: [control()] })).toEqual([
            { controlId: 'c1', title: 'Root MFA', status: 'ok', reason: '' },
        ]);
    });

    it('walks nested groups', () => {
        const parsed = parsePowerpipeBenchmarkJson({
            groups: [
                { controls: [control({ control_id: 'x.control.a' })] },
                { groups: [{ controls: [control({ control_id: 'x.control.b' })] }] },
            ],
        });
        expect(parsed.map((c) => c.controlId)).toEqual(['a', 'b']);
    });

    it('falls back to `name` when control_id is absent, and skips id-less controls', () => {
        const parsed = parsePowerpipeBenchmarkJson({
            controls: [
                control({ control_id: undefined, name: 'x.control.named' }),
                control({ control_id: undefined, name: undefined }),
            ],
        });
        expect(parsed.map((c) => c.controlId)).toEqual(['named']);
    });

    it('deduplicates by short id, keeping the first', () => {
        const parsed = parsePowerpipeBenchmarkJson({
            controls: [
                control({ control_id: 'a.control.dup', title: 'First' }),
                control({ control_id: 'b.control.dup', title: 'Second' }),
            ],
        });
        expect(parsed).toHaveLength(1);
        expect(parsed[0].title).toBe('First');
    });

    it('defaults the title to the short id', () => {
        expect(
            parsePowerpipeBenchmarkJson({ controls: [control({ title: undefined })] })[0]
                .title,
        ).toBe('c1');
    });

    describe('status aggregation from the summary block', () => {
        const statusOf = (summary: unknown) =>
            parsePowerpipeBenchmarkJson({ controls: [control({ summary })] })[0].status;

        it('ranks alarm above error above ok', () => {
            expect(statusOf({ status: { alarm: 1, error: 1, ok: 1 } })).toBe('alarm');
            expect(statusOf({ status: { error: 1, ok: 1 } })).toBe('error');
            expect(statusOf({ status: { ok: 1 } })).toBe('ok');
        });

        it('falls to skip when every counter is zero or absent', () => {
            expect(statusOf({ status: { alarm: 0, error: 0, ok: 0 } })).toBe('skip');
            expect(statusOf({ status: {} })).toBe('skip');
        });
    });

    describe('status aggregation from result rows', () => {
        const statusOf = (results: unknown) =>
            parsePowerpipeBenchmarkJson({
                controls: [control({ summary: undefined, results })],
            })[0].status;

        it('ranks alarm above error above ok', () => {
            expect(statusOf([{ status: 'ok' }, { status: 'alarm' }])).toBe('alarm');
            expect(statusOf([{ status: 'ok' }, { status: 'error' }])).toBe('error');
            expect(statusOf([{ status: 'ok' }])).toBe('ok');
        });

        it('falls to skip with no rows or only unknown statuses', () => {
            expect(statusOf([])).toBe('skip');
            expect(statusOf(undefined)).toBe('skip');
            expect(statusOf([{ status: 'weird' }])).toBe('skip');
        });
    });

    it('reports the first reason matching the aggregated status', () => {
        const [c] = parsePowerpipeBenchmarkJson({
            controls: [
                control({
                    summary: undefined,
                    results: [
                        { status: 'ok', reason: 'fine' },
                        { status: 'alarm', reason: 'root MFA disabled' },
                        { status: 'alarm', reason: 'second alarm' },
                    ],
                }),
            ],
        });
        expect(c.status).toBe('alarm');
        expect(c.reason).toBe('root MFA disabled');
    });

    it('defaults the reason to empty when the matching row carries none', () => {
        const [c] = parsePowerpipeBenchmarkJson({
            controls: [control({ summary: undefined, results: [{ status: 'ok' }] })],
        });
        expect(c.reason).toBe('');
    });
});

describe('scrubAwsCredentials', () => {
    it('redacts long-term and temporary access key ids', () => {
        // AWS's own published placeholder key id — not a credential.
        expect(scrubAwsCredentials('key AKIAIOSFODNN7EXAMPLE here')).toBe( // pragma: allowlist secret
            'key [REDACTED] here',
        );
        expect(scrubAwsCredentials('key ASIAIOSFODNN7EXAMPLE here')).toBe( // pragma: allowlist secret
            'key [REDACTED] here',
        );
    });

    it('redacts a 40-character secret access key', () => {
        const secret = 'a'.repeat(40);
        expect(scrubAwsCredentials(`secret=${secret}`)).toContain('[REDACTED]');
        expect(scrubAwsCredentials(`secret=${secret}`)).not.toContain(secret);
    });

    it('redacts a session token assignment', () => {
        const out = scrubAwsCredentials(
            'AWS_SESSION_TOKEN=abcdefghijklmnopqrstuvwxyz0123456789',
        );
        expect(out).toContain('[REDACTED]');
    });

    it('redacts IAM ARNs carrying the account id', () => {
        expect(
            scrubAwsCredentials('arn:aws:iam::123456789012:role/PostureReader'),
        ).toBe('[REDACTED]');
    });

    it('redacts the exact connection secrets supplied', () => {
        const out = scrubAwsCredentials('token=supersecretvalue!', [
            'supersecretvalue!',
        ]);
        expect(out).toBe('token=[REDACTED]');
    });

    it('ignores short secret values rather than over-redacting', () => {
        // A <8-char secret would match far too much innocent text.
        expect(scrubAwsCredentials('the cat sat', ['cat'])).toBe('the cat sat');
    });

    it('ignores empty secret entries', () => {
        expect(scrubAwsCredentials('plain text', ['', undefined as never])).toBe(
            'plain text',
        );
    });

    it('handles empty and nullish input', () => {
        expect(scrubAwsCredentials('')).toBe('');
        expect(scrubAwsCredentials(undefined as never)).toBe('');
    });

    it('leaves innocuous text untouched', () => {
        expect(scrubAwsCredentials('benchmark completed with 3 alarms')).toBe(
            'benchmark completed with 3 alarms',
        );
    });
});

describe('summariseBenchmark', () => {
    const ctl = (id: string, status: 'ok' | 'alarm' | 'skip' | 'error') => ({
        controlId: id,
        title: id,
        status,
        reason: '',
    });

    it('counts each status and the total', () => {
        const s = summariseBenchmark('soc2', [
            ctl('a', 'ok'),
            ctl('b', 'alarm'),
            ctl('c', 'skip'),
            ctl('d', 'error'),
            ctl('e', 'ok'),
        ]);
        expect(s.benchmark).toBe('soc2');
        expect(s.counts).toEqual({ ok: 2, alarm: 1, skip: 1, error: 1, total: 5 });
        expect(s.truncated).toBe(false);
    });

    it('carries only id + status per control — never resources or reasons', () => {
        const s = summariseBenchmark('soc2', [ctl('a', 'ok')]);
        expect(s.controls).toEqual([{ id: 'a', status: 'ok' }]);
    });

    it('handles an empty control set', () => {
        const s = summariseBenchmark('cis', []);
        expect(s.counts.total).toBe(0);
        expect(s.controls).toEqual([]);
        expect(s.truncated).toBe(false);
    });

    it('truncates the per-control list to stay under the byte cap', () => {
        const many = Array.from({ length: 4000 }, (_, i) =>
            ctl(`control_with_a_fairly_long_identifier_${i}`, 'ok'),
        );
        const s = summariseBenchmark('soc2', many);

        expect(s.truncated).toBe(true);
        expect(s.controls.length).toBeLessThan(many.length);
        // The counts still describe the FULL run, not the truncated list.
        expect(s.counts.total).toBe(4000);
        expect(
            Buffer.byteLength(
                JSON.stringify({
                    benchmark: 'soc2',
                    counts: s.counts,
                    controls: s.controls,
                }),
            ),
        ).toBeLessThanOrEqual(RESULT_JSON_MAX_BYTES);
    });
});

describe('buildCredentialEnv', () => {
    it('passes each supplied credential through the environment', () => {
        const env = buildCredentialEnv(
            {
                accessKeyId: 'AKIA_X',
                secretAccessKey: 'SECRET_X',
                sessionToken: 'TOKEN_X',
                roleArn: 'arn:aws:iam::1:role/R',
                externalId: 'EXT_X',
            },
            { region: 'eu-west-1' },
        );
        expect(env.AWS_ACCESS_KEY_ID).toBe('AKIA_X');
        expect(env.AWS_SECRET_ACCESS_KEY).toBe('SECRET_X');
        expect(env.AWS_SESSION_TOKEN).toBe('TOKEN_X');
        expect(env.AWS_ROLE_ARN).toBe('arn:aws:iam::1:role/R');
        expect(env.AWS_EXTERNAL_ID).toBe('EXT_X');
        expect(env.AWS_REGION).toBe('eu-west-1');
    });

    it('omits every key that was not supplied', () => {
        const env = buildCredentialEnv({}, {});
        expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
        expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
        expect(env.AWS_SESSION_TOKEN).toBeUndefined();
        expect(env.AWS_ROLE_ARN).toBeUndefined();
        expect(env.AWS_EXTERNAL_ID).toBeUndefined();
    });

    it('inherits the parent environment', () => {
        const env = buildCredentialEnv({}, {});
        expect(env.PATH).toBe(process.env.PATH);
    });

    it('does not mutate process.env', () => {
        buildCredentialEnv({ accessKeyId: 'AKIA_LEAK' }, {});
        expect(process.env.AWS_ACCESS_KEY_ID).not.toBe('AKIA_LEAK');
    });
});
