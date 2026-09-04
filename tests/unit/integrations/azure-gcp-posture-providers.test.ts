/**
 * Branch coverage for the two Powerpipe-backed cloud-posture providers:
 *   src/app-layer/integrations/providers/azure-posture-provider.ts
 *   src/app-layer/integrations/providers/gcp-posture-provider.ts
 *
 * `tests/unit/cloud-posture.test.ts` covers the happy path of each. What is
 * pinned here is everything a broken/partial connection hits:
 *
 *   • every `validateConnection` refusal, with its EXACT operator-facing
 *     message — the four Azure/GCP refusals are the only signal a customer
 *     gets about which field they got wrong;
 *   • the credential ENV builders, including the omit-when-absent branches
 *     (an env var set to `undefined` would make the CLI authenticate as the
 *     collector host's own identity rather than the tenant's);
 *   • the benchmark-id resolution ladder including the unknown-shorthand
 *     fallback and the `parsed.checkType` fallback;
 *   • that each provider's own credential PATTERN set reaches the scrubber,
 *     proving redaction is wired per cloud rather than inherited from AWS;
 *   • `mapResultToEvidence` refusing to mint evidence from a broken run.
 *
 * The injected `exec` seam mirrors the real runner: it applies the module's
 * own `scrubSecrets` to the captured streams using the arguments the provider
 * handed it, so the assertions above are end-to-end rather than "the array
 * had the right shape".
 */
import { scrubSecrets } from '@/app-layer/integrations/cloud-posture/powerpipe-core';
import { AzurePostureProvider } from '@/app-layer/integrations/providers/azure-posture-provider';
import { GcpPostureProvider } from '@/app-layer/integrations/providers/gcp-posture-provider';
import type { CheckInput, CheckResult } from '@/app-layer/integrations/types';
import {
    powerpipeControl,
    type PowerpipeRowStatus,
} from '../../helpers/powerpipe-benchmark-fixture';

interface ExecCall {
    file: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    secretValues: string[];
    patterns: RegExp[];
}

/**
 * A recording stand-in for the module-private `runCli`. It scrubs exactly the
 * way the real one does, so a provider that forgets to pass its patterns or
 * its secret values produces visibly unredacted output here.
 */
function recordingExec(
    stdout: string,
    over: { ok?: boolean; stderr?: string; missing?: boolean; code?: number | null } = {},
) {
    const calls: ExecCall[] = [];
    const exec = async (
        file: string,
        args: string[],
        env: NodeJS.ProcessEnv,
        secretValues: string[],
        patterns: RegExp[],
    ) => {
        calls.push({ file, args, env, secretValues, patterns });
        return {
            ok: over.ok ?? true,
            stdout: scrubSecrets(stdout, secretValues, patterns),
            stderr: scrubSecrets(over.stderr ?? '', secretValues, patterns),
            missing: over.missing ?? false,
            code: over.code,
        };
    };
    return { exec, calls };
}

/** Controls in the REAL wire shape, from the source-cited fixture module. */
const control = (id: string, status: PowerpipeRowStatus) =>
    powerpipeControl(`x.control.${id}`, status, { title: id });
const benchmarkJson = (controls: unknown[]) => JSON.stringify({ controls });
const OK_JSON = benchmarkJson([control('a', 'ok')]);
const MIXED_JSON = benchmarkJson([control('a', 'ok'), control('b', 'alarm')]);

function checkInput(
    provider: string,
    checkType: string,
    connectionConfig: Record<string, unknown>,
): CheckInput {
    return {
        automationKey: `${provider}.${checkType}`,
        parsed: { provider, checkType, raw: `${provider}.${checkType}` },
        tenantId: 'tenant-1',
        connectionConfig,
        triggeredBy: 'scheduled',
    };
}

const result = (status: CheckResult['status'], summary = 'sum'): CheckResult => ({
    status,
    summary,
    details: {},
});

// ═══ Azure ═══════════════════════════════════════════════════════════

describe('AzurePostureProvider.benchmarkId', () => {
    it('maps the two shorthands case-insensitively', () => {
        expect(AzurePostureProvider.benchmarkId('soc2')).toBe('azure_compliance.benchmark.soc_2');
        expect(AzurePostureProvider.benchmarkId('cis')).toBe('azure_compliance.benchmark.cis_v200');
        expect(AzurePostureProvider.benchmarkId('CIS')).toBe('azure_compliance.benchmark.cis_v200');
    });

    it('falls back to SOC 2 for an absent or unrecognised shorthand', () => {
        // Falling back to SOC 2 (rather than throwing or running nothing) is
        // the deliberate choice; a typo'd config must still produce a run.
        expect(AzurePostureProvider.benchmarkId(undefined)).toBe(
            'azure_compliance.benchmark.soc_2',
        );
        expect(AzurePostureProvider.benchmarkId('pci')).toBe('azure_compliance.benchmark.soc_2');
        expect(AzurePostureProvider.benchmarkId('')).toBe('azure_compliance.benchmark.soc_2');
    });
});

describe('AzurePostureProvider.validateConnection', () => {
    const provider = new AzurePostureProvider();
    const SUB_ERR = 'Azure tenant id + subscription id are required.';
    const SP_ERR = 'A service-principal client id + secret are required.';

    it('refuses when the tenant id is missing', async () => {
        expect(
            await provider.validateConnection({ subscriptionId: 's' }, { clientId: 'c', clientSecret: 'x' }),
        ).toEqual({ valid: false, error: SUB_ERR });
    });

    it('refuses when the subscription id is missing', async () => {
        expect(
            await provider.validateConnection({ tenantId: 't' }, { clientId: 'c', clientSecret: 'x' }),
        ).toEqual({ valid: false, error: SUB_ERR });
    });

    it('refuses when the client id is missing', async () => {
        expect(
            await provider.validateConnection({ tenantId: 't', subscriptionId: 's' }, { clientSecret: 'x' }),
        ).toEqual({ valid: false, error: SP_ERR });
    });

    it('refuses when the client secret is missing', async () => {
        expect(
            await provider.validateConnection({ tenantId: 't', subscriptionId: 's' }, { clientId: 'c' }),
        ).toEqual({ valid: false, error: SP_ERR });
    });

    it('reports the SUBSCRIPTION problem first when both halves are missing', async () => {
        // Ordering matters for the operator: fix the config fields before the
        // secret fields, since the secret is re-entered on every edit.
        expect(await provider.validateConnection({}, {})).toEqual({ valid: false, error: SUB_ERR });
    });

    it('accepts a complete service principal', async () => {
        expect(
            await provider.validateConnection(
                { tenantId: 't', subscriptionId: 's' },
                { clientId: 'c', clientSecret: 'x' },
            ),
        ).toEqual({ valid: true });
    });

    it('never opens a socket — it declares itself non-live', () => {
        expect(provider.liveValidation).toBe(false);
        expect(provider.id).toBe('azure-posture');
        expect(provider.supportedChecks).toEqual(['soc2', 'cis']);
    });
});

describe('AzurePostureProvider.runCheck — credential env', () => {
    it('projects every supplied field onto its AZURE_* variable', async () => {
        const { exec, calls } = recordingExec(OK_JSON);
        await new AzurePostureProvider({ exec }).runCheck(
            checkInput('azure-posture', 'soc2', {
                benchmark: 'soc2',
                tenantId: 'tenant-guid',
                subscriptionId: 'sub-guid',
                clientId: 'client-guid',
                clientSecret: 'client-secret-value', // pragma: allowlist secret — synthetic placeholder
            }),
        );

        expect(calls[0].env.AZURE_TENANT_ID).toBe('tenant-guid');
        expect(calls[0].env.AZURE_SUBSCRIPTION_ID).toBe('sub-guid');
        expect(calls[0].env.AZURE_CLIENT_ID).toBe('client-guid');
        expect(calls[0].env.AZURE_CLIENT_SECRET).toBe('client-secret-value');
    });

    it('omits every AZURE_* variable that was not configured', async () => {
        // Setting a var to undefined would leave the CLI falling back to the
        // collector host's own az login — a cross-tenant read.
        const { exec, calls } = recordingExec(OK_JSON);
        await new AzurePostureProvider({ exec }).runCheck(
            checkInput('azure-posture', 'soc2', { benchmark: 'soc2' }),
        );

        // `not.toHaveProperty` rather than `toBeUndefined`: setting the key to
        // an undefined VALUE is a different (and wrong) behaviour that
        // `toBeUndefined` could not tell apart from omitting it.
        expect(calls[0].env).not.toHaveProperty('AZURE_TENANT_ID');
        expect(calls[0].env).not.toHaveProperty('AZURE_SUBSCRIPTION_ID');
        expect(calls[0].env).not.toHaveProperty('AZURE_CLIENT_ID');
        expect(calls[0].env).not.toHaveProperty('AZURE_CLIENT_SECRET');
    });

    it('inherits the parent environment without mutating it', async () => {
        const { exec, calls } = recordingExec(OK_JSON);
        await new AzurePostureProvider({ exec }).runCheck(
            checkInput('azure-posture', 'soc2', { benchmark: 'soc2', clientSecret: 'leak-me' }),
        );
        expect(calls[0].env.PATH).toBe(process.env.PATH);
        expect(process.env.AZURE_CLIENT_SECRET).not.toBe('leak-me');
    });

    it('nominates the client SECRET for redaction, and only when present', async () => {
        const withSecret = recordingExec(OK_JSON);
        await new AzurePostureProvider({ exec: withSecret.exec }).runCheck(
            checkInput('azure-posture', 'soc2', {
                benchmark: 'soc2',
                clientId: 'client-guid',
                clientSecret: 'client-secret-value', // pragma: allowlist secret — synthetic placeholder
            }),
        );
        expect(withSecret.calls[0].secretValues).toStrictEqual(['client-secret-value']);
    });

    it('hands the redaction list NO undefined slot when the secret is absent', async () => {
        // This is what `.filter((v): v is string => !!v)` in runCheck buys, and
        // it needs `toStrictEqual` to be checkable at all: Jest's `toEqual`
        // ignores undefined array members, so `expect([undefined]).toEqual([])`
        // PASSES and a dropped filter is invisible to it. The list is declared
        // `string[]` and every consumer downstream — today `scrubSecrets`, and
        // any future redactor that does not happen to guard on truthiness —
        // is entitled to that. A `[undefined]` here is a typed lie at the seam.
        const withoutSecret = recordingExec(OK_JSON);
        await new AzurePostureProvider({ exec: withoutSecret.exec }).runCheck(
            checkInput('azure-posture', 'soc2', { benchmark: 'soc2', clientId: 'client-guid' }),
        );
        const handed = withoutSecret.calls[0].secretValues;
        expect(handed).toStrictEqual([]);
        expect(handed).toHaveLength(0);
        expect(handed.every((v) => typeof v === 'string')).toBe(true);
    });

    it('redacts Azure GUIDs from surfaced collector output via its own pattern set', async () => {
        // The GUID pattern is Azure-specific — proving it reaches the scrubber
        // is what stops a subscription/tenant id landing in a persisted
        // IntegrationExecution row.
        const { exec } = recordingExec('', {
            ok: false,
            stderr: 'AADSTS700016: app 11111111-2222-3333-4444-555555555555 not found in tenant 99999999-8888-7777-6666-555555555555',
        });
        const res = await new AzurePostureProvider({ exec }).runCheck(
            checkInput('azure-posture', 'soc2', { benchmark: 'soc2' }),
        );
        expect(res.status).toBe('ERROR');
        expect(res.errorMessage).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
        expect(res.errorMessage).toContain('AADSTS700016');
        expect(res.errorMessage).toContain('[REDACTED]');
    });
});

describe('AzurePostureProvider.runCheck — benchmark selection + verdict', () => {
    it('prefers the configured benchmark over the check type', async () => {
        const { exec, calls } = recordingExec(OK_JSON);
        await new AzurePostureProvider({ exec }).runCheck(
            checkInput('azure-posture', 'soc2', { benchmark: 'cis' }),
        );
        expect(calls[0].args[2]).toBe('azure_compliance.benchmark.cis_v200');
    });

    it('falls back to the automationKey check type when no benchmark is configured', async () => {
        const { exec, calls } = recordingExec(OK_JSON);
        await new AzurePostureProvider({ exec }).runCheck(checkInput('azure-posture', 'cis', {}));
        expect(calls[0].args[2]).toBe('azure_compliance.benchmark.cis_v200');
    });

    it('returns a CheckResult and never leaks the internal summary object', async () => {
        // `summaryObj` is a core-internal handle; the provider contract is a
        // plain CheckResult, and callers persist this object verbatim.
        const { exec } = recordingExec(MIXED_JSON);
        const res = await new AzurePostureProvider({ exec }).runCheck(
            checkInput('azure-posture', 'soc2', { benchmark: 'soc2' }),
        );
        expect(res.status).toBe('FAILED');
        expect(Object.keys(res).sort()).toEqual(['details', 'durationMs', 'status', 'summary']);
    });

    it('propagates a fail-closed refusal from the core unchanged', async () => {
        const { exec } = recordingExec('', { ok: false, missing: true });
        const res = await new AzurePostureProvider({ exec }).runCheck(
            checkInput('azure-posture', 'soc2', { benchmark: 'soc2' }),
        );
        expect(res.status).toBe('ERROR');
        expect(res.summary).toBe('Powerpipe CLI not installed on the collector host.');
    });
});

describe('AzurePostureProvider.mapResultToEvidence', () => {
    const provider = new AzurePostureProvider();
    const input = checkInput('azure-posture', 'cis', {});

    it('mints configuration evidence for a real verdict', () => {
        expect(provider.mapResultToEvidence(input, result('PASSED', '10 ok / 0 alarm'))).toEqual({
            title: 'Azure posture — cis',
            content: '10 ok / 0 alarm',
            type: 'CONFIGURATION',
            category: 'azure-posture:cis',
        });
    });

    it('mints evidence for a FAILED verdict too — it is a real observation', () => {
        expect(provider.mapResultToEvidence(input, result('FAILED'))).not.toBeNull();
    });

    it('mints NOTHING from a broken run (H2)', () => {
        expect(provider.mapResultToEvidence(input, result('ERROR'))).toBeNull();
    });
});

// ═══ GCP ═════════════════════════════════════════════════════════════

describe('GcpPostureProvider.benchmarkId', () => {
    it('maps the two shorthands case-insensitively', () => {
        expect(GcpPostureProvider.benchmarkId('soc2')).toBe('gcp_compliance.benchmark.soc_2');
        expect(GcpPostureProvider.benchmarkId('cis')).toBe('gcp_compliance.benchmark.cis_v200');
        expect(GcpPostureProvider.benchmarkId('CIS')).toBe('gcp_compliance.benchmark.cis_v200');
    });

    it('falls back to SOC 2 for an absent or unrecognised shorthand', () => {
        expect(GcpPostureProvider.benchmarkId(undefined)).toBe('gcp_compliance.benchmark.soc_2');
        expect(GcpPostureProvider.benchmarkId('pci')).toBe('gcp_compliance.benchmark.soc_2');
    });
});

describe('GcpPostureProvider.validateConnection', () => {
    const provider = new GcpPostureProvider();
    const sa = { client_email: 'reader@p.iam.gserviceaccount.com', private_key: '-----BEGIN-----' };

    it('refuses without a project id, before it even looks at the key', async () => {
        expect(
            await provider.validateConnection({}, { serviceAccountJson: JSON.stringify(sa) }),
        ).toEqual({ valid: false, error: 'A GCP project id is required.' });
    });

    it('refuses without a service-account key', async () => {
        expect(await provider.validateConnection({ projectId: 'p' }, {})).toEqual({
            valid: false,
            error: 'A service-account JSON key is required.',
        });
    });

    it('refuses an empty-string key rather than parsing it', async () => {
        expect(
            await provider.validateConnection({ projectId: 'p' }, { serviceAccountJson: '' }),
        ).toEqual({ valid: false, error: 'A service-account JSON key is required.' });
    });

    it('refuses text that is not JSON', async () => {
        expect(
            await provider.validateConnection({ projectId: 'p' }, { serviceAccountJson: '{oops' }),
        ).toEqual({ valid: false, error: 'Service-account JSON is not valid JSON.' });
    });

    it('refuses a key with no client_email', async () => {
        expect(
            await provider.validateConnection(
                { projectId: 'p' },
                { serviceAccountJson: JSON.stringify({ private_key: 'k' }) },
            ),
        ).toEqual({
            valid: false,
            error: 'Service-account JSON is missing client_email / private_key.',
        });
    });

    it('refuses a key with no private_key', async () => {
        expect(
            await provider.validateConnection(
                { projectId: 'p' },
                { serviceAccountJson: JSON.stringify({ client_email: 'x@y.com' }) },
            ),
        ).toEqual({
            valid: false,
            error: 'Service-account JSON is missing client_email / private_key.',
        });
    });

    it('accepts a complete key supplied as a JSON string', async () => {
        expect(
            await provider.validateConnection(
                { projectId: 'p' },
                { serviceAccountJson: JSON.stringify(sa) },
            ),
        ).toEqual({ valid: true });
    });

    it('accepts a key already decoded into an object', async () => {
        // The secrets bag is `Record<string, unknown>`; a caller that decoded
        // the key upstream must not be forced to re-stringify it.
        expect(
            await provider.validateConnection({ projectId: 'p' }, { serviceAccountJson: sa }),
        ).toEqual({ valid: true });
    });

    it('never opens a socket — it declares itself non-live', () => {
        expect(provider.liveValidation).toBe(false);
        expect(provider.id).toBe('gcp-posture');
        expect(provider.supportedChecks).toEqual(['soc2', 'cis']);
    });
});

describe('GcpPostureProvider.runCheck — with the exec seam injected', () => {
    it('pins the project on CLOUDSDK_CORE_PROJECT', async () => {
        const { exec, calls } = recordingExec(OK_JSON);
        await new GcpPostureProvider({ exec }).runCheck(
            checkInput('gcp-posture', 'soc2', { benchmark: 'soc2', projectId: 'my-project' }),
        );
        expect(calls[0].env.CLOUDSDK_CORE_PROJECT).toBe('my-project');
    });

    it('leaves CLOUDSDK_CORE_PROJECT unset when no project is configured', async () => {
        // Unset means "whatever the mod resolves"; setting it to undefined
        // would be indistinguishable but is not what the code does.
        const { exec, calls } = recordingExec(OK_JSON);
        await new GcpPostureProvider({ exec }).runCheck(
            checkInput('gcp-posture', 'soc2', { benchmark: 'soc2' }),
        );
        expect(calls[0].env).not.toHaveProperty('CLOUDSDK_CORE_PROJECT');
    });

    it('does NOT write a credential file when the exec seam is injected', async () => {
        // The seam short-circuits the temp-file dance; GOOGLE_APPLICATION_
        // CREDENTIALS must therefore stay unset rather than point at nothing.
        const { exec, calls } = recordingExec(OK_JSON);
        await new GcpPostureProvider({ exec }).runCheck(
            checkInput('gcp-posture', 'soc2', {
                benchmark: 'soc2',
                serviceAccountJson: JSON.stringify({ client_email: 'a', private_key: 'k' }),
            }),
        );
        expect(calls[0].env).not.toHaveProperty('GOOGLE_APPLICATION_CREDENTIALS');
    });

    it('nominates the whole SA key for redaction, and only when present', async () => {
        const key = JSON.stringify({ client_email: 'a', private_key: 'k' });
        const withKey = recordingExec(OK_JSON);
        await new GcpPostureProvider({ exec: withKey.exec }).runCheck(
            checkInput('gcp-posture', 'soc2', { benchmark: 'soc2', serviceAccountJson: key }),
        );
        expect(withKey.calls[0].secretValues).toStrictEqual([key]);
    });

    it('hands the redaction list NO undefined slot when the SA key is absent', async () => {
        // Twin of the Azure case above — same `toStrictEqual` requirement,
        // because `toEqual` cannot tell `[]` from `[undefined]`.
        const withoutKey = recordingExec(OK_JSON);
        await new GcpPostureProvider({ exec: withoutKey.exec }).runCheck(
            checkInput('gcp-posture', 'soc2', { benchmark: 'soc2' }),
        );
        const handed = withoutKey.calls[0].secretValues;
        expect(handed).toStrictEqual([]);
        expect(handed).toHaveLength(0);
        expect(handed.every((v) => typeof v === 'string')).toBe(true);
    });

    it('redacts service-account emails from surfaced collector output', async () => {
        // GCP-specific pattern: the SA email identifies the principal the
        // customer granted access to and must not persist in a failure row.
        const { exec } = recordingExec('', {
            ok: false,
            stderr: 'permission denied for posture-reader@my-proj.iam.gserviceaccount.com',
        });
        const res = await new GcpPostureProvider({ exec }).runCheck(
            checkInput('gcp-posture', 'soc2', { benchmark: 'soc2' }),
        );
        expect(res.status).toBe('ERROR');
        expect(res.errorMessage).not.toContain('gserviceaccount.com');
        expect(res.errorMessage).toBe('collector error; stderr: permission denied for [REDACTED]');
    });

    it('redacts a whole private-key block from surfaced collector output', async () => {
        const pem = '-----BEGIN PRIVATE KEY-----\nMIIabc123\n-----END PRIVATE KEY-----'; // pragma: allowlist secret — synthetic PEM header, input to the redaction assertion
        const { exec } = recordingExec('', { ok: false, stderr: `bad key ${pem} rejected` });
        const res = await new GcpPostureProvider({ exec }).runCheck(
            checkInput('gcp-posture', 'soc2', { benchmark: 'soc2' }),
        );
        // The multi-line PEM must go as ONE block, not leave the base64 body
        // behind after the header is stripped.
        expect(res.errorMessage).toBe('collector error; stderr: bad key [REDACTED] rejected');
    });

    it('falls back to the automationKey check type when no benchmark is configured', async () => {
        const { exec, calls } = recordingExec(OK_JSON);
        await new GcpPostureProvider({ exec }).runCheck(checkInput('gcp-posture', 'cis', {}));
        expect(calls[0].args[2]).toBe('gcp_compliance.benchmark.cis_v200');
    });

    it('returns a CheckResult and never leaks the internal summary object', async () => {
        const { exec } = recordingExec(MIXED_JSON);
        const res = await new GcpPostureProvider({ exec }).runCheck(
            checkInput('gcp-posture', 'soc2', { benchmark: 'soc2' }),
        );
        expect(res.status).toBe('FAILED');
        expect(Object.keys(res).sort()).toEqual(['details', 'durationMs', 'status', 'summary']);
    });

    it('propagates a fail-closed refusal from the core unchanged', async () => {
        // The double reports failure with no exit status — a signal death or a
        // spawn failure, which is what `{ok:false}` alone models. A non-zero
        // EXIT is a different thing: powerpipe's 1 and 2 are completed runs and
        // are parsed (see the exit-code suite in powerpipe-core.test.ts).
        const { exec } = recordingExec('', { ok: false, stderr: 'permission denied' });
        const res = await new GcpPostureProvider({ exec }).runCheck(
            checkInput('gcp-posture', 'soc2', { benchmark: 'soc2' }),
        );
        expect(res.status).toBe('ERROR');
        expect(res.summary).toBe('Powerpipe collector did not complete the run.');
        expect(res.errorMessage).toContain('permission denied');
    });

    it('scores an exit-1 run rather than refusing it — the alarms reach the caller', async () => {
        // #2284, at the provider seam: the Azure/GCP providers hand the core's
        // result straight through, so the routine "controls alarmed" outcome
        // has to arrive as a verdict here, not as a collector error.
        const { exec } = recordingExec(MIXED_JSON, { ok: false, code: 1 });
        const res = await new GcpPostureProvider({ exec }).runCheck(
            checkInput('gcp-posture', 'soc2', { benchmark: 'soc2' }),
        );
        expect(res.status).toBe('FAILED');
        expect(res.details).toMatchObject({ collectorExitCode: 1 });
    });
});

describe('GcpPostureProvider.mapResultToEvidence', () => {
    const provider = new GcpPostureProvider();
    const input = checkInput('gcp-posture', 'cis', {});

    it('mints configuration evidence for a real verdict', () => {
        expect(provider.mapResultToEvidence(input, result('PASSED', '10 ok / 0 alarm'))).toEqual({
            title: 'GCP posture — cis',
            content: '10 ok / 0 alarm',
            type: 'CONFIGURATION',
            category: 'gcp-posture:cis',
        });
    });

    it('mints evidence for a FAILED verdict too — it is a real observation', () => {
        expect(provider.mapResultToEvidence(input, result('FAILED'))).not.toBeNull();
    });

    it('mints NOTHING from a broken run (H2)', () => {
        expect(provider.mapResultToEvidence(input, result('ERROR'))).toBeNull();
    });
});
