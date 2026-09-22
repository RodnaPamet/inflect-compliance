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
import { codeOf } from '../helpers/source-blocks';

// #2246 Class A — the mask goes at the READ SEAM, and WHICH masker depends on
// the language. `read` stays RAW because this file also reads JSON and YAML, none of
// which `codeOf` lexes — handing it YAML once blanked a bare-scalar URL from
// `//` to end of line. TypeScript reads go through `readSrc`, which masks.
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const readSrc = (rel: string) => codeOf(read(rel));

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


/**
 * #2246 CLASS B — THE ARM TABLE, and why it is a fixture rather than an
 * assertion.
 *
 * `cloud-posture.ts` takes a `cloud` parameter, and every test passed
 * `'azure-posture'`. At runtime the parameter and the hard-coded literal were
 * THE SAME STRING, so replacing `input.cloud` with the literal survived at
 * every site — at 100% branch coverage. #2245 closed the thirteen `input.cloud`
 * sites one at a time; the survivors were on `c.id`, `checkResult.status`,
 * `evidenceCreated` and `now`, the same class on values nobody had named.
 *
 * Per-site assertions are the instance-level fix and will miss the next site.
 * The issue's own warning is the one to heed: round two "changed one fixture
 * value and thereby MOVED the coincidence rather than removing it."
 *
 * So each arm gets its OWN benchmark id, its OWN control ids and its OWN status
 * mix. A derived value is then distinguishable from any constant in scope BY
 * CONSTRUCTION — substituting one arm's literal for a derived value fails on
 * the other arm, and substituting a constant fails on both. Both arms sharing
 * one `BENCH_JSON` was precisely what made the coincidence possible.
 */
const ARMS = [
    {
        cloud: 'azure-posture' as const,
        benchmarkId: 'azure_compliance.benchmark.soc_2',
        // Distinct ids AND a distinct alarm/ok split, so neither the ids nor
        // the counts can be confused with the other arm's.
        controls: [
            { id: 'az_storage_encrypted', status: 'ok' as const, title: 'Azure storage encrypted' },
            { id: 'az_mfa_enforced', status: 'alarm' as const, title: 'Azure MFA enforced' },
        ],
        connectionConfig: { benchmark: 'soc2', clientSecret: 'x' },
    },
    {
        cloud: 'gcp-posture' as const,
        benchmarkId: 'gcp_compliance.benchmark.soc_2',
        controls: [
            { id: 'gcp_bucket_private', status: 'alarm' as const, title: 'GCP bucket private' },
            { id: 'gcp_sa_key_rotation', status: 'alarm' as const, title: 'GCP SA key rotation' },
            { id: 'gcp_audit_logs_on', status: 'skip' as const, title: 'GCP audit logs' },
        ],
        connectionConfig: { benchmark: 'soc2', serviceAccountJson: '{}' },
    },
] as const;

function armJson(arm: (typeof ARMS)[number]): string {
    return powerpipeBenchmarkJson(arm.benchmarkId, {
        groups: [
            powerpipeGroup('cc6', {
                controls: arm.controls.map((c) =>
                    powerpipeControl(c.id, c.status, { title: c.title }),
                ),
            }),
        ],
    });
}

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
        // The SOC 2 criteria come from the CatalogFile production applies,
        // not from prisma/seed.ts. seed.ts built SOC 2 a second time until
        // its duplicate block was removed; reading the criteria from a file
        // production never runs was always the weaker source, and after the
        // convergence it is no source at all.
        const icSoc2 = new Set(
            (
                JSON.parse(read('prisma/fixtures/soc2-control-templates.json')) as {
                    requirements: Array<{ code: string }>;
                }
            ).requirements.map((r) => r.code),
        );
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
        expect(readSrc('src/data/integrations/azure-posture-control-map.ts')).not.toMatch(/@prisma\/client/);
        expect(readSrc('src/data/integrations/gcp-posture-control-map.ts')).not.toMatch(/@prisma\/client/);
    });
});

describe('#2246 Class B — each cloud is distinguishable from every other by construction', () => {
    const PROVIDERS = {
        'azure-posture': AzurePostureProvider,
        'gcp-posture': GcpPostureProvider,
    } as const;

    for (const arm of ARMS) {
        it(`${arm.cloud}: the result carries THIS arm's control ids, not another arm's`, async () => {
            const Provider = PROVIDERS[arm.cloud];
            const provider = new Provider({ exec: fakeExec(armJson(arm)) });
            const r = await provider.runCheck({
                automationKey: `${arm.cloud}.soc2`,
                parsed: { provider: arm.cloud, checkType: 'soc2', raw: `${arm.cloud}.soc2` },
                tenantId: 't',
                connectionConfig: arm.connectionConfig,
                triggeredBy: 'scheduled',
            });

            const details = r.details as { controls?: Array<{ id: string; status: string }> };
            const ids = (details.controls ?? []).map((c) => c.id).join(' ');

            // Every id this arm declares is present...
            for (const c of arm.controls) {
                expect({ arm: arm.cloud, id: c.id, present: ids.includes(c.id) }).toEqual({
                    arm: arm.cloud,
                    id: c.id,
                    present: true,
                });
            }
            // ...and NO id belonging to a different arm is. This is the half
            // that makes a substituted constant fail: a hard-coded id from the
            // other arm would satisfy the first loop on that arm and this one
            // never.
            for (const other of ARMS) {
                if (other.cloud === arm.cloud) continue;
                for (const c of other.controls) {
                    expect({ arm: arm.cloud, foreignId: c.id, leaked: ids.includes(c.id) }).toEqual({
                        arm: arm.cloud,
                        foreignId: c.id,
                        leaked: false,
                    });
                }
            }
        });

        it(`${arm.cloud}: status is DERIVED from this arm's rows, not a constant`, async () => {
            const Provider = PROVIDERS[arm.cloud];
            const provider = new Provider({ exec: fakeExec(armJson(arm)) });
            const r = await provider.runCheck({
                automationKey: `${arm.cloud}.soc2`,
                parsed: { provider: arm.cloud, checkType: 'soc2', raw: `${arm.cloud}.soc2` },
                tenantId: 't',
                connectionConfig: arm.connectionConfig,
                triggeredBy: 'scheduled',
            });

            // Both arms alarm, so status alone cannot separate them — the
            // COUNTS can, and they differ by construction (1 alarm vs 2).
            const alarms = arm.controls.filter((c) => c.status === 'alarm').length;
            const details = r.details as { counts?: Record<string, number> };
            expect({ arm: arm.cloud, status: r.status }).toEqual({ arm: arm.cloud, status: 'FAILED' });
            expect({ arm: arm.cloud, alarm: details.counts?.alarm }).toEqual({
                arm: arm.cloud,
                alarm: alarms,
            });
        });
    }

    it('the arms genuinely differ — otherwise every assertion above is vacuous', () => {
        // The positive control for the whole table. If two arms ever collapse
        // onto the same fixture, the "no foreign id leaked" checks pass for the
        // wrong reason, which is exactly how the original coincidence hid.
        const ids = ARMS.map((a) => a.controls.map((c) => c.id).sort().join(','));
        expect(new Set(ids).size).toBe(ARMS.length);
        expect(new Set(ARMS.map((a) => a.benchmarkId)).size).toBe(ARMS.length);
        expect(new Set(ARMS.map((a) => a.controls.filter((c) => c.status === 'alarm').length)).size)
            .toBe(ARMS.length);
    });
});
