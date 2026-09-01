/**
 * Unit coverage for the aws-posture connector's pure logic: Powerpipe JSON
 * parsing, credential scrubbing, bounded summarisation, and the control map.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    parsePowerpipeBenchmarkJson,
    shortControlName,
    scrubAwsCredentials,
    summariseBenchmark,
    RESULT_JSON_MAX_BYTES,
    AwsPostureProvider,
    type PowerpipeControlResult,
} from '@/app-layer/integrations/aws-posture-provider';
import { soc2CodesForControl, allMappedRequirementCodes, AWS_POSTURE_CONTROL_MAP } from '@/data/integrations/aws-posture-control-map';

const FIXTURE = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../fixtures/aws-posture-powerpipe-soc2.json'), 'utf8'),
);

describe('aws-posture — Powerpipe JSON parsing', () => {
    it('flattens the nested group tree into per-control statuses', () => {
        const controls = parsePowerpipeBenchmarkJson(FIXTURE);
        const byId = Object.fromEntries(controls.map((c) => [c.controlId, c.status]));
        expect(byId['iam_root_user_mfa_enabled']).toBe('ok');
        expect(byId['s3_bucket_public_access_blocked']).toBe('ok');
        expect(byId['iam_user_mfa_enabled']).toBe('alarm');
        expect(byId['cloudtrail_multi_region_trail_enabled']).toBe('ok');
        expect(byId['guardduty_enabled']).toBe('skip');
        expect(controls).toHaveLength(5);
    });

    it('strips the aws_compliance.control. prefix', () => {
        expect(shortControlName('aws_compliance.control.iam_root_user_mfa_enabled')).toBe('iam_root_user_mfa_enabled');
        expect(shortControlName('bare_name')).toBe('bare_name');
    });

    it('tolerates malformed input', () => {
        expect(parsePowerpipeBenchmarkJson({})).toEqual([]);
        expect(parsePowerpipeBenchmarkJson(null)).toEqual([]);
    });
});

describe('aws-posture — credential scrubbing', () => {
    it('redacts AWS key ids, ARNs, and the connection secret values', () => {
        const raw = 'token AKIAIOSFODNN7EXAMPLE for arn:aws:iam::123456789012:user/deploy with secret abcd1234SECRETvalue987'; // pragma: allowlist secret — synthetic AWS docs example key, input for the scrub test
        const scrubbed = scrubAwsCredentials(raw, ['abcd1234SECRETvalue987']); // pragma: allowlist secret
        expect(scrubbed).not.toContain('AKIAIOSFODNN7EXAMPLE'); // pragma: allowlist secret
        expect(scrubbed).not.toContain('123456789012');
        expect(scrubbed).not.toContain('abcd1234SECRETvalue987');
        expect(scrubbed).toContain('[REDACTED]');
    });

    it('a sensitive identifier in a fixture reason is scrubbed before use', () => {
        const controls = parsePowerpipeBenchmarkJson(FIXTURE);
        const s3 = controls.find((c) => c.controlId === 's3_bucket_public_access_blocked')!;
        // The fixture reason embeds an IAM ARN (account id) — scrubAwsCredentials
        // must redact it before the reason is ever persisted/logged.
        expect(scrubAwsCredentials(s3.reason)).not.toContain('123456789012');
    });
});

describe('aws-posture — bounded summary', () => {
    it('counts by status and stays under the size cap', () => {
        const controls = parsePowerpipeBenchmarkJson(FIXTURE);
        const summary = summariseBenchmark('aws_compliance.benchmark.soc_2', controls);
        expect(summary.counts).toEqual({ ok: 3, alarm: 1, skip: 1, error: 0, total: 5 });
        expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThanOrEqual(RESULT_JSON_MAX_BYTES);
    });

    it('truncates a huge control list to fit the cap (no raw dumps)', () => {
        const many: PowerpipeControlResult[] = Array.from({ length: 5000 }, (_, i) => ({
            controlId: `control_number_${i}_with_a_longish_name`, title: 't', status: 'ok', reason: 'x',
        }));
        const summary = summariseBenchmark('b', many);
        expect(summary.truncated).toBe(true);
        expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThanOrEqual(RESULT_JSON_MAX_BYTES);
        // The summary carries only {id,status} per control — never resources/reasons.
        expect(JSON.stringify(summary)).not.toContain('reason');
    });
});

describe('aws-posture — control map', () => {
    it('maps known checks to SOC 2 codes', () => {
        expect(soc2CodesForControl('iam_root_user_mfa_enabled')).toContain('CC6.1');
        expect(soc2CodesForControl('cloudtrail_multi_region_trail_enabled')).toContain('CC7.1');
        expect(soc2CodesForControl('config_enabled_all_regions')).toContain('CC8.1');
        expect(soc2CodesForControl('unmapped_check')).toEqual([]);
    });

    it('every mapped SOC 2 code is a real IC SOC 2 requirement code', () => {
        // IC's SOC2 codes (seed.ts soc2Reqs).
        const IC_SOC2 = new Set(['CC1.1', 'CC1.2', 'CC2.1', 'CC3.1', 'CC4.1', 'CC5.1', 'CC6.1', 'CC7.1', 'CC8.1', 'CC9.1']);
        for (const code of allMappedRequirementCodes().soc2) {
            expect(IC_SOC2.has(code)).toBe(true);
        }
        expect(Object.keys(AWS_POSTURE_CONTROL_MAP).length).toBeGreaterThanOrEqual(12);
    });
});

describe('aws-posture — benchmark id resolution + wiring', () => {
    it('resolves the shorthand to a Powerpipe benchmark id', () => {
        expect(AwsPostureProvider.benchmarkId('soc2')).toBe('aws_compliance.benchmark.soc_2');
        expect(AwsPostureProvider.benchmarkId('cis')).toBe('aws_compliance.benchmark.cis_v300');
        expect(AwsPostureProvider.benchmarkId(undefined)).toBe('aws_compliance.benchmark.soc_2');
    });
});
