/**
 * aws-posture connector — structural ratchet.
 *
 * Locks the load-bearing properties of the cloud-posture evidence connector:
 * provider registration, executor wiring, credential hygiene, mapping validity,
 * evidence provenance, and the no-ported-HCL/SQL license tripwire.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const PROVIDER = 'src/app-layer/integrations/aws-posture-provider.ts';
const USECASE = 'src/app-layer/usecases/aws-posture.ts';
const JOB = 'src/app-layer/jobs/aws-posture-collect.ts';
const MAP = 'src/data/integrations/aws-posture-control-map.ts';

describe('aws-posture — registration + wiring', () => {
    it('provider is registered in bootstrap', () => {
        const boot = read('src/app-layer/integrations/bootstrap.ts');
        expect(boot).toMatch(/import \{ AwsPostureProvider \} from '\.\/aws-posture-provider'/);
        expect(boot).toMatch(/registry\.register\(new AwsPostureProvider\(\)\)/);
    });

    it('executor is registered + typed in the job payload map, tenant-scoped', () => {
        const reg = read('src/app-layer/jobs/executor-registry.ts');
        expect(reg).toMatch(/executorRegistry\.register\('aws-posture-collect'/);
        const types = read('src/app-layer/jobs/types.ts');
        expect(types).toMatch(/'aws-posture-collect': AwsPostureCollectPayload/);
        expect(types).toMatch(/interface AwsPostureCollectPayload[\s\S]*tenantId: string[\s\S]*connectionId: string/);
        // The collection runs inside a tenant-scoped context (RLS), not global prisma.
        const uc = read(USECASE);
        expect(uc).toMatch(/runInTenantContext/);
        expect(uc).not.toMatch(/from '@\/lib\/prisma'/);
    });
});

describe('aws-posture — credential hygiene', () => {
    const provider = read(PROVIDER);
    const usecase = read(USECASE);

    it('passes credentials via env, never via CLI argv', () => {
        // The CLI is invoked with a STATIC arg array; creds go through buildCredentialEnv → env.
        expect(provider).toMatch(/execFile\(/);
        expect(provider).toMatch(/buildCredentialEnv/);
        expect(provider).toMatch(/AWS_ACCESS_KEY_ID/);
        // No secret field name appears inside an args array literal.
        expect(provider).not.toMatch(/args?\s*[:=]\s*\[[^\]]*(accessKeyId|secretAccessKey|sessionToken|AWS_SECRET)/);
    });

    it('scrubs stdout/stderr + persisted error text before use', () => {
        expect(provider).toMatch(/scrubAwsCredentials/);
        // runCli scrubs both streams.
        expect(provider).toMatch(/scrubAwsCredentials\(String\(stdout/);
        expect(provider).toMatch(/scrubAwsCredentials\(String\(stderr/);
        // The usecase scrubs any error text before persisting to the execution row.
        expect(usecase).toMatch(/scrubAwsCredentials\(/);
    });

    it('resultJson is size-capped (no raw resource dumps)', () => {
        expect(provider).toMatch(/RESULT_JSON_MAX_BYTES\s*=\s*32 \* 1024/);
        expect(provider).toMatch(/summariseBenchmark/);
        // resultJson persisted is the bounded summary, not raw controls.
        expect(usecase).toMatch(/resultJson: summary/);
    });
});

describe('aws-posture — mapping validity', () => {
    it('every mapped SOC 2 code resolves to a real IC SOC 2 requirement', () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { allMappedRequirementCodes } = require('@/data/integrations/aws-posture-control-map');
        // IC's seeded SOC2 codes (prisma/seed.ts soc2Reqs).
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
        expect(icSoc2.size).toBeGreaterThanOrEqual(5);
        for (const code of allMappedRequirementCodes().soc2) {
            expect(icSoc2.has(code)).toBe(true);
        }
    });

    it('every mapped NIST CSF code resolves to a real subcategory in the NIST CSF library', () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { allMappedRequirementCodes } = require('@/data/integrations/aws-posture-control-map');
        // NIST CSF 2.0 is an installable YAML library — resolve against its ref_ids.
        const yaml = read('src/data/libraries/nist-csf-2.0.yaml');
        const icCsf = new Set(
            [...yaml.matchAll(/ref_id:\s*([A-Z]{2}\.[A-Z]{2}-\d+)/g)].map((m) => m[1]),
        );
        expect(icCsf.size).toBeGreaterThanOrEqual(5);
        const mappedCsf = allMappedRequirementCodes().nistCsf;
        expect(mappedCsf.length).toBeGreaterThan(0);
        for (const code of mappedCsf) {
            expect(icCsf.has(code)).toBe(true);
        }
    });

    it('the map module holds no Prisma import (pure data)', () => {
        const map = read(MAP);
        expect(map).not.toMatch(/@prisma\/client/);
        expect(map).not.toMatch(/from '@\/lib\/prisma'/);
        expect(map).not.toMatch(/runInTenantContext/);
    });
});

describe('aws-posture — evidence provenance', () => {
    const usecase = read(USECASE);

    it('auto-evidence is tagged aws-posture:* and carries the execution id', () => {
        expect(usecase).toMatch(/category = `aws-posture:\$\{c\.id\}`/);
        expect(usecase).toMatch(/kind: 'INTEGRATION_RESULT'/);
        expect(usecase).toMatch(/integrationResultId: execution\.id/);
        // Evidence is written through the tenant-scoped db inside runInTenantContext
        // (the automated-evidence seam), and only for PASSING controls.
        expect(usecase).toMatch(/if \(c\.status !== 'ok'\) continue/);
    });

    it('failing/alarm controls do NOT auto-create risks', () => {
        expect(usecase).not.toMatch(/createRisk\(/);
    });

    it('the job file exists and delegates to the usecase', () => {
        const job = read(JOB);
        expect(job).toMatch(/runAwsPostureCollection/);
    });
});

describe('aws-posture — license tripwire (no ported HCL/SQL from the mod)', () => {
    it('no Powerpipe .pp / HCL benchmark or control blocks are present in the repo', () => {
        // The mod is invoked as an external CLI; its HCL/SQL must never be ported.
        const dirs = ['src', 'prisma/fixtures', 'docs'];
        const offenders: string[] = [];
        const hclControlBlock = /\b(benchmark|control|query)\s+"[^"]+"\s*\{/; // HCL resource block
        const walk = (dir: string) => {
            const abs = path.join(ROOT, dir);
            if (!fs.existsSync(abs)) return;
            for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
                const rel = path.join(dir, e.name);
                if (e.isDirectory()) walk(rel);
                else if (e.name.endsWith('.pp')) offenders.push(`${rel} (.pp file)`);
                else if (/aws.posture|aws.compliance/i.test(e.name) && /\.(hcl|sql)$/.test(e.name)) offenders.push(rel);
            }
        };
        for (const d of dirs) walk(d);
        // Spot-check our own connector files carry no HCL control blocks.
        for (const f of [PROVIDER, MAP]) {
            if (hclControlBlock.test(read(f))) offenders.push(`${f} (HCL block)`);
        }
        expect(offenders).toEqual([]);
    });
});
