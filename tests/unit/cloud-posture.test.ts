/**
 * PR-3 — Azure + GCP cloud-posture: shared Powerpipe core, per-provider
 * runCheck (via injected CLI), credential scrubbing, and control-map validity.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    runPowerpipeBenchmark,
    scrubSecrets,
    frameworkCodesForControl,
    type CloudPostureControlMapEntry,
} from '@/app-layer/integrations/cloud-posture/powerpipe-core';
import {
    powerpipeBenchmarkJson,
    powerpipeControl,
    powerpipeCounts,
    powerpipeGroup,
} from '../helpers/powerpipe-benchmark-fixture';
import { AzurePostureProvider } from '@/app-layer/integrations/providers/azure-posture-provider';
import { GcpPostureProvider } from '@/app-layer/integrations/providers/gcp-posture-provider';
import { AZURE_POSTURE_CONTROL_MAP, allMappedRequirementCodes as azureCodes } from '@/data/integrations/azure-posture-control-map';
import { GCP_POSTURE_CONTROL_MAP, allMappedRequirementCodes as gcpCodes } from '@/data/integrations/gcp-posture-control-map';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * A Powerpipe benchmark JSON with a mix of ok/alarm/skip controls, in the REAL
 * wire shape — flat control counters inside nested group counters. Built from
 * the source-cited fixture module so it cannot drift back into agreeing with
 * whatever the parser happens to expect.
 */
const BENCH_JSON = powerpipeBenchmarkJson('aws_compliance.benchmark.soc_2', {
    groups: [
        powerpipeGroup('cc6', {
            controls: [
                powerpipeControl('a_ok', 'ok', { summary: powerpipeCounts('ok', 3), title: 'A' }),
                powerpipeControl('b_alarm', 'alarm', { summary: { ...powerpipeCounts('alarm', 2), ok: 1 }, title: 'B' }),
                powerpipeControl('c_skip', 'skip', { title: 'C' }),
            ],
        }),
    ],
});

/** An injectable exec that returns our fake JSON. */
function fakeExec(stdout: string, missing = false) {
    return async () => ({ ok: true, stdout, stderr: '', missing });
}

describe('runPowerpipeBenchmark', () => {
    it('FAILs when any control alarms; counts land in details', async () => {
        const r = await runPowerpipeBenchmark({ benchmarkId: 'azure_compliance.benchmark.soc_2', env: process.env, secretValues: [], exec: fakeExec(BENCH_JSON) });
        expect(r.status).toBe('FAILED');
        expect(r.summaryObj?.counts.total).toBe(3);
        expect(r.summaryObj?.counts.alarm).toBe(1);
    });

    it('PASSes when no control alarms', async () => {
        const allOk = powerpipeBenchmarkJson('b', { controls: [powerpipeControl('x.control.ok', 'ok')] });
        const r = await runPowerpipeBenchmark({ benchmarkId: 'b', env: process.env, secretValues: [], exec: fakeExec(allOk) });
        expect(r.status).toBe('PASSED');
    });

    it('ERRORs when the CLI is missing', async () => {
        const r = await runPowerpipeBenchmark({ benchmarkId: 'b', env: process.env, secretValues: [], exec: fakeExec('', true) });
        expect(r.status).toBe('ERROR');
    });
});

describe('scrubSecrets', () => {
    it('redacts secret values and pattern matches', () => {
        const out = scrubSecrets('secret=supersecretvalue and key aaaa-bbbb', ['supersecretvalue'], [/aaaa-bbbb/g]);
        expect(out).not.toContain('supersecretvalue');
        expect(out).not.toContain('aaaa-bbbb');
        expect(out).toContain('[REDACTED]');
    });
});

describe('frameworkCodesForControl', () => {
    const map: Record<string, CloudPostureControlMapEntry> = { x: { label: 'X', soc2: ['CC6.1'], nistCsf: ['PR.AA-01'] } };
    it('returns per-framework code groups; empty for unknown', () => {
        expect(frameworkCodesForControl(map, 'x')).toEqual([
            { frameworkKey: 'SOC2', codes: ['CC6.1'] },
            { frameworkKey: 'NIST-CSF-2.0', codes: ['PR.AA-01'] },
        ]);
        expect(frameworkCodesForControl(map, 'nope')).toEqual([]);
    });
});

describe('AzurePostureProvider', () => {
    const provider = new AzurePostureProvider({ exec: fakeExec(BENCH_JSON) });
    it('resolves benchmark ids', () => {
        expect(AzurePostureProvider.benchmarkId('cis')).toBe('azure_compliance.benchmark.cis_v200');
        expect(AzurePostureProvider.benchmarkId(undefined)).toBe('azure_compliance.benchmark.soc_2');
    });
    it('validateConnection requires tenant/sub + client creds', async () => {
        expect((await provider.validateConnection({}, {})).valid).toBe(false);
        expect((await provider.validateConnection({ tenantId: 't', subscriptionId: 's' }, { clientId: 'c', clientSecret: 'x' })).valid).toBe(true);
    });
    it('runCheck maps the benchmark to a CheckResult', async () => {
        const r = await provider.runCheck({ automationKey: 'azure-posture.soc2', parsed: { provider: 'azure-posture', checkType: 'soc2', raw: 'azure-posture.soc2' }, tenantId: 't', connectionConfig: { benchmark: 'soc2', clientSecret: 'x' }, triggeredBy: 'scheduled' });
        expect(r.status).toBe('FAILED');
        expect(provider.mapResultToEvidence({ automationKey: 'azure-posture.soc2', parsed: { provider: 'azure-posture', checkType: 'soc2', raw: '' }, tenantId: 't', connectionConfig: {}, triggeredBy: 'scheduled' }, r)?.type).toBe('CONFIGURATION');
    });
});

describe('GcpPostureProvider', () => {
    const provider = new GcpPostureProvider({ exec: fakeExec(BENCH_JSON) });
    it('validateConnection checks project + SA JSON shape', async () => {
        expect((await provider.validateConnection({ projectId: 'p' }, { serviceAccountJson: 'nope' })).valid).toBe(false);
        expect((await provider.validateConnection({ projectId: 'p' }, { serviceAccountJson: JSON.stringify({ client_email: 'x', private_key: 'k' }) })).valid).toBe(true);
    });
    it('runCheck maps the benchmark to a CheckResult (exec injected → no temp file)', async () => {
        const r = await provider.runCheck({ automationKey: 'gcp-posture.soc2', parsed: { provider: 'gcp-posture', checkType: 'soc2', raw: 'gcp-posture.soc2' }, tenantId: 't', connectionConfig: { benchmark: 'soc2', serviceAccountJson: '{}' }, triggeredBy: 'scheduled' });
        expect(r.status).toBe('FAILED');
    });
});

describe('control-map validity', () => {
    const seed = read('prisma/seed.ts');
    const icSoc2 = new Set([...seed.matchAll(/code: '(CC\d\.\d)'/g)].map((m) => m[1]));
    const csfYaml = read('src/data/libraries/nist-csf-2.0.yaml');
    const icCsf = new Set([...csfYaml.matchAll(/ref_id:\s*([A-Z]{2}\.[A-Z]{2}-\d+)/g)].map((m) => m[1]));

    for (const [name, codes] of [['azure', azureCodes()], ['gcp', gcpCodes()]] as const) {
        it(`${name} map SOC 2 codes all resolve to seeded requirements`, () => {
            expect(icSoc2.size).toBeGreaterThanOrEqual(5);
            for (const c of codes.soc2) expect(icSoc2.has(c)).toBe(true);
        });
        it(`${name} map NIST CSF codes all resolve to library subcategories`, () => {
            expect(icCsf.size).toBeGreaterThanOrEqual(5);
            for (const c of codes.nistCsf) expect(icCsf.has(c)).toBe(true);
        });
    }

    it('the maps are non-empty and pure (no prisma import)', () => {
        expect(Object.keys(AZURE_POSTURE_CONTROL_MAP).length).toBeGreaterThan(5);
        expect(Object.keys(GCP_POSTURE_CONTROL_MAP).length).toBeGreaterThan(5);
        expect(read('src/data/integrations/azure-posture-control-map.ts')).not.toMatch(/@prisma\/client/);
        expect(read('src/data/integrations/gcp-posture-control-map.ts')).not.toMatch(/@prisma\/client/);
    });
});
