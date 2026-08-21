/**
 * PR-2 — Okta + Google Workspace identity connectors: structural ratchet.
 *
 * Locks provider registration, the 5-step job wiring, tenant-scoping of the
 * sync usecase, and the ConnectedIdentityAccount RLS + tenant-index shape.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readPrismaSchema } from '../helpers/prisma-schema';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('identity providers — registration + wiring', () => {
    it('both providers are registered in bootstrap', () => {
        const boot = read('src/app-layer/integrations/bootstrap.ts');
        expect(boot).toMatch(/import \{ OktaProvider \} from '\.\/providers\/okta'/);
        expect(boot).toMatch(/import \{ GoogleWorkspaceProvider \} from '\.\/providers\/google-workspace'/);
        expect(boot).toMatch(/registry\.register\(new OktaProvider\(\)\)/);
        expect(boot).toMatch(/registry\.register\(new GoogleWorkspaceProvider\(\)\)/);
    });

    it('identity-sync jobs are typed in the payload map + registered in the executor', () => {
        const types = read('src/app-layer/jobs/types.ts');
        expect(types).toMatch(/'identity-sync': IdentitySyncPayload/);
        expect(types).toMatch(/'identity-sync-dispatch': IdentitySyncDispatchPayload/);
        expect(types).toMatch(/interface IdentitySyncPayload[\s\S]*tenantId: string[\s\S]*connectionId: string/);
        const reg = read('src/app-layer/jobs/executor-registry.ts');
        expect(reg).toMatch(/executorRegistry\.register\('identity-sync'/);
        expect(reg).toMatch(/executorRegistry\.register\('identity-sync-dispatch'/);
    });

    it('the dispatch job is scheduled on a cron', () => {
        const sched = read('src/app-layer/jobs/schedules.ts');
        expect(sched).toMatch(/name: 'identity-sync-dispatch'/);
    });

    it('the sync usecase is tenant-scoped (runInTenantContext, not global prisma)', () => {
        const uc = read('src/app-layer/usecases/identity-sync.ts');
        expect(uc).toMatch(/runInTenantContext/);
        expect(uc).not.toMatch(/from '@\/lib\/prisma'/);
    });

    it('ConnectedIdentityAccount carries RLS + tenant indexes', () => {
        const schema = readPrismaSchema();
        expect(schema).toMatch(/model ConnectedIdentityAccount \{/);
        // PHASE 2: the grain is the connection. Two directory connections for one
        // provider are supported — IntegrationConnection is unique on
        // (tenantId, provider, NAME) — so an account is identified by WHICH
        // directory it came from, not merely by which kind. The old key made two
        // forests collide on one row and is what forced the deprovision reconcile
        // to be provider-scoped.
        expect(schema).toMatch(/@@unique\(\[tenantId, connectionId, externalUserId\]\)/);
        expect(schema).toMatch(/@@index\(\[tenantId, provider\]\)/);
        expect(schema).toMatch(/@@index\(\[tenantId, status\]\)/);
        // RLS migration present with the standard triple.
        const mig = read('prisma/migrations/20260707100000_connected_identity_account/migration.sql');
        expect(mig).toMatch(/ENABLE ROW LEVEL SECURITY/);
        expect(mig).toMatch(/FORCE ROW LEVEL SECURITY/);
        expect(mig).toMatch(/CREATE POLICY tenant_isolation ON "ConnectedIdentityAccount"/);
        expect(mig).toMatch(/CREATE POLICY tenant_isolation_insert ON "ConnectedIdentityAccount"/);
        expect(mig).toMatch(/CREATE POLICY superuser_bypass ON "ConnectedIdentityAccount"/);
    });
});
