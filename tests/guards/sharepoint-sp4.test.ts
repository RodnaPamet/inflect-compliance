/**
 * SP-4 ratchet — bidirectional policy sync + the Graph webhook must stay wired:
 * the sync usecase (link/unlink/push/pull/conflict), the webhook handshake +
 * clientState verification, the pull + renew jobs, the Policy SP columns, the
 * publish→push hook, and the policy-detail link section.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readPrismaSchema } from '../helpers/prisma-schema';
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => codeOf(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));

describe('SP-4 SharePoint policy sync', () => {
    it('the sync usecase exposes link/unlink/push/pull/conflict', () => {
        const src = read('src/app-layer/usecases/policy-sharepoint-sync.ts');
        for (const fn of [
            'linkPolicyToSharePoint',
            'unlinkPolicyFromSharePoint',
            'pushPolicyToSharePoint',
            'pullPolicyFromSharePoint',
            'getPolicySharePointStatus',
        ]) {
            expect(src).toContain(`export async function ${fn}`);
        }
        expect(src).toMatch(/text\/markdown/); // synced as markdown, no DOCX dep
    });

    it('the webhook does the validationToken handshake + verifies clientState', () => {
        const wh = read('src/app/api/webhooks/sharepoint/route.ts');
        expect(wh).toMatch(/validationToken/);
        expect(wh).toMatch(/text\/plain/);
        expect(wh).toMatch(/clientState/);
        expect(wh).toMatch(/spSubscriptionId/); // anti-spoof lookup
        expect(wh).toMatch(/sharepoint-policy-pull/);
    });

    it('the pull + renew jobs are registered (+ renew is scheduled)', () => {
        const reg = read('src/app-layer/jobs/executor-registry.ts');
        expect(reg).toMatch(/register\('sharepoint-policy-pull'/);
        expect(reg).toMatch(/register\('sharepoint-subscription-renew'/);
        expect(read('src/app-layer/jobs/schedules.ts')).toMatch(/sharepoint-subscription-renew/);
    });

    it('Policy has the SharePoint link columns + migration', () => {
        const schema = codeOf(readPrismaSchema());
        for (const col of ['spDriveId', 'spItemId', 'spItemETag', 'spWebUrl', 'spSubscriptionId']) {
            expect(schema).toMatch(new RegExp(`${col}\\s+String\\?`));
        }
        expect(exists('prisma/migrations/20260609140000_policy_sharepoint_link/migration.sql')).toBe(true);
    });

    it('publishPolicy pushes to SharePoint (best-effort, outside the tx)', () => {
        expect(read('src/app-layer/usecases/policy.ts')).toMatch(/pushPolicyToSharePoint/);
    });

    it('the policy detail page mounts the SharePoint link section', () => {
        expect(read('src/app/t/[tenantSlug]/(app)/policies/[policyId]/page.tsx')).toMatch(/PolicySharePointSection/);
        expect(exists('src/app/t/[tenantSlug]/(app)/policies/[policyId]/PolicySharePointSection.tsx')).toBe(true);
    });
});
