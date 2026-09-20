/**
 * PR-3 — Azure + GCP cloud-posture connectors: structural ratchet.
 *
 * Locks provider registration, executor wiring, credential hygiene (creds via
 * env not argv; secrets scrubbed), the shared-core reuse, and the tenant-scope
 * of the collector usecase.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
// Masked at the READ seam (#2246 Class A): comments blanked, string
// literals kept, offsets preserved — so a token that survives only in
// a comment can no longer satisfy an assertion below.
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const AZURE = 'src/app-layer/integrations/providers/azure-posture-provider.ts';
const GCP = 'src/app-layer/integrations/providers/gcp-posture-provider.ts';
const CORE = 'src/app-layer/integrations/cloud-posture/powerpipe-core.ts';
const USECASE = 'src/app-layer/usecases/cloud-posture.ts';

describe('cloud-posture (Azure + GCP) — registration + wiring', () => {
    it('both providers are registered in bootstrap', () => {
        const boot = read('src/app-layer/integrations/bootstrap.ts');
        expect(boot).toMatch(/import \{ AzurePostureProvider \} from '\.\/providers\/azure-posture-provider'/);
        expect(boot).toMatch(/import \{ GcpPostureProvider \} from '\.\/providers\/gcp-posture-provider'/);
        expect(boot).toMatch(/registry\.register\(new AzurePostureProvider\(\)\)/);
        expect(boot).toMatch(/registry\.register\(new GcpPostureProvider\(\)\)/);
    });

    it('collector jobs are typed in the payload map + registered in the executor', () => {
        const types = read('src/app-layer/jobs/types.ts');
        expect(types).toMatch(/'azure-posture-collect': AzurePostureCollectPayload/);
        expect(types).toMatch(/'gcp-posture-collect': GcpPostureCollectPayload/);
        const reg = read('src/app-layer/jobs/executor-registry.ts');
        expect(reg).toMatch(/executorRegistry\.register\('azure-posture-collect'/);
        expect(reg).toMatch(/executorRegistry\.register\('gcp-posture-collect'/);
    });

    it('the collector usecase is tenant-scoped (runInTenantContext, not global prisma)', () => {
        const uc = read(USECASE);
        expect(uc).toMatch(/runInTenantContext/);
        expect(uc).not.toMatch(/from '@\/lib\/prisma'/);
    });

    it('shared core reuses the cloud-agnostic parser + summariser (no duplication)', () => {
        const core = read(CORE);
        expect(core).toMatch(/parsePowerpipeBenchmarkJson/);
        expect(core).toMatch(/summariseBenchmark/);
        expect(core).toMatch(/from '\.\.\/aws-posture-provider'/);
    });

    it('credentials go via env, never argv; secrets scrubbed', () => {
        // Azure sets AZURE_* on env; GCP writes SA JSON to a temp file (env path).
        expect(read(AZURE)).toMatch(/AZURE_CLIENT_SECRET/);
        expect(read(GCP)).toMatch(/GOOGLE_APPLICATION_CREDENTIALS/);
        // The core scrubs both output streams via scrubSecrets.
        const core = read(CORE);
        expect(core).toMatch(/scrubSecrets\(String\(stdout/);
        expect(core).toMatch(/scrubSecrets\(String\(stderr/);
    });

    it('the map modules hold no Prisma import (pure data)', () => {
        for (const m of ['src/data/integrations/azure-posture-control-map.ts', 'src/data/integrations/gcp-posture-control-map.ts']) {
            expect(read(m)).not.toMatch(/@prisma\/client/);
            expect(read(m)).not.toMatch(/from '@\/lib\/prisma'/);
        }
    });
});
