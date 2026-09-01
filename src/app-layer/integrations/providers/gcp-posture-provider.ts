/**
 * gcp-posture provider (PR-3) — GCP cloud-posture compliance evidence.
 *
 * Engine: Powerpipe + the Apache-2.0 `steampipe-mod-gcp-compliance` mod,
 * invoked as an EXTERNAL CLI. We consume its JSON and apply an ORIGINAL thin
 * control map (`gcp-posture-control-map.ts`) — no HCL/SQL is ported.
 *
 * SECURITY: a read-only service-account JSON key is written to a
 * restricted-perm temp file (steampipe's GCP plugin reads
 * `GOOGLE_APPLICATION_CREDENTIALS`), used, then unlinked. The key is never
 * placed on argv and is scrubbed from any captured output.
 */
import { writeFile, unlink, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
    ScheduledCheckProvider,
    ConnectionConfigSchema,
    ConnectionValidationResult,
    CheckInput,
    CheckResult,
    EvidencePayload,
} from '../types';
import { runPowerpipeBenchmark, type RunBenchmarkInput } from '../cloud-posture/powerpipe-core';

export interface GcpPostureConfig {
    benchmark?: string;
    projectId?: string;
}

const BENCHMARKS: Record<string, string> = {
    soc2: 'gcp_compliance.benchmark.soc_2',
    cis: 'gcp_compliance.benchmark.cis_v200',
};

// Redact private-key blocks + service-account emails from output.
const GCP_CREDENTIAL_PATTERNS: RegExp[] = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    /[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com/gi,
];

export class GcpPostureProvider implements ScheduledCheckProvider {
    readonly id = 'gcp-posture';
    readonly displayName = 'GCP Cloud Posture';
    readonly description = 'Run a CIS / SOC 2 benchmark against a GCP project (read-only) and collect per-control evidence.';
    readonly supportedChecks = ['soc2', 'cis'];
    // P2 — validateConnection only parses the SA JSON shape (no live API call).
    readonly liveValidation = false;
    readonly setupGuide =
        'Runs Powerpipe on the collector host against a GCP project. Create a read-only service account, grant it the security-reviewer role on the project, and paste its key JSON below. Test connection validates the JSON shape only — it does not call GCP live.';

    readonly configSchema: ConnectionConfigSchema = {
        configFields: [
            { key: 'benchmark', label: 'Benchmark', type: 'select', required: true, options: ['soc2', 'cis'] },
            { key: 'projectId', label: 'GCP project id', type: 'string', required: true },
        ],
        secretFields: [
            { key: 'serviceAccountJson', label: 'Service-account JSON', type: 'textarea', required: true, description: 'A read-only service-account key (JSON) — paste the whole file.' },
        ],
    };

    private readonly exec?: RunBenchmarkInput['exec'];
    constructor(deps: { exec?: RunBenchmarkInput['exec'] } = {}) {
        this.exec = deps.exec;
    }

    static benchmarkId(shorthand: string | undefined): string {
        return BENCHMARKS[(shorthand ?? 'soc2').toLowerCase()] ?? BENCHMARKS.soc2;
    }

    async validateConnection(config: Record<string, unknown>, secrets: Record<string, unknown>): Promise<ConnectionValidationResult> {
        if (!config.projectId) return { valid: false, error: 'A GCP project id is required.' };
        const raw = secrets.serviceAccountJson;
        if (!raw) return { valid: false, error: 'A service-account JSON key is required.' };
        try {
            const sa = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (!sa.client_email || !sa.private_key) return { valid: false, error: 'Service-account JSON is missing client_email / private_key.' };
            return { valid: true };
        } catch {
            return { valid: false, error: 'Service-account JSON is not valid JSON.' };
        }
    }

    async runCheck(input: CheckInput): Promise<CheckResult> {
        const cfg = input.connectionConfig as GcpPostureConfig & { serviceAccountJson?: string };
        const benchmarkId = GcpPostureProvider.benchmarkId(cfg.benchmark ?? input.parsed.checkType);
        const saJson = cfg.serviceAccountJson ?? '';
        const secretValues = saJson ? [saJson] : [];

        // Write the SA key to a restricted temp file for the GCP plugin.
        let credPath: string | null = null;
        let dir: string | null = null;
        const env: NodeJS.ProcessEnv = { ...process.env };
        if (cfg.projectId) env.CLOUDSDK_CORE_PROJECT = cfg.projectId;
        try {
            if (saJson && !this.exec) {
                dir = await mkdtemp(join(tmpdir(), 'gcp-posture-'));
                credPath = join(dir, 'sa.json');
                await writeFile(credPath, saJson, { mode: 0o600 });
                env.GOOGLE_APPLICATION_CREDENTIALS = credPath;
            }
            const { summaryObj: _s, ...result } = await runPowerpipeBenchmark({ benchmarkId, env, secretValues, patterns: GCP_CREDENTIAL_PATTERNS, exec: this.exec });
            return result;
        } finally {
            // Unlink FIRST, then remove the directory. The two are not
            // interchangeable: if `rm` fails (EPERM, stale NFS) the key must
            // already be gone, so the secret's removal never depends on the
            // directory's. `rm` on its own would make it.
            if (credPath) await unlink(credPath).catch(() => {});
            // The directory itself outlived every run before this line: only
            // the file was removed, so a scheduled check leaked one empty
            // `gcp-posture-*` inode per execution for the life of the
            // container. `force` so an already-unlinked tree is not an error.
            if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
        }
    }

    mapResultToEvidence(input: CheckInput, result: CheckResult): EvidencePayload | null {
        if (result.status === 'ERROR') return null;
        return { title: `GCP posture — ${input.parsed.checkType}`, content: result.summary, type: 'CONFIGURATION', category: `gcp-posture:${input.parsed.checkType}` };
    }
}
