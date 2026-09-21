/**
 * PR-8 — gated trust-center documents: structural security ratchet. The
 * public gated module stays import-isolated; tokens are hashed + single-use +
 * expiring; the models carry RLS.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readPrismaSchema } from '../helpers/prisma-schema';

// #2246 Class A / #2679 LANGUAGE SPLIT — comments are masked at the READ SEAM,
// and WHICH masker depends on the language of the file being read.
//
// `codeOf` lexes TypeScript. Handing it a `.sql` file is the single worst
// outcome available: every `--` comment survives verbatim while the call site
// READS as masked. Migrations therefore go through `readSql`, which lexes
// `--` and `/* */` (and nests, as Postgres does). TypeScript keeps `read`.
// Which extension flows through which helper was re-derived in this file, not
// assumed from the directory it lives in.
import { codeOf, sqlCodeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const readRaw = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const read = (rel: string) => codeOf(readRaw(rel));
const readSql = (rel: string) => sqlCodeOf(readRaw(rel));
describe('trust-center gated documents — security invariants', () => {
    const gated = read('src/lib/trust-center/gated.ts');

    it('the public gated module imports NOTHING from the tenant-data layer', () => {
        expect(gated).not.toMatch(/from ['"]@\/app-layer\/(repositories|usecases)\/(risk|control|evidence|finding|Risk|Control|Evidence|Finding)/);
        // only prisma + crypto
        expect(gated).toMatch(/from '@\/lib\/prisma'/);
        expect(gated).toMatch(/import crypto from 'crypto'/);
    });

    it('resolves only ENABLED trust centers by public slug (no existence disclosure)', () => {
        expect(gated).toMatch(/where: \{ slug, enabled: true \}/);
        // request + consume return null on failure paths
        expect(gated).toMatch(/return null/);
    });

    it('download tokens are hashed, single-use, and expiring', () => {
        expect(gated).toMatch(/createHash\('sha256'\)/);
        // single-use: consume claims atomically on downloadedAt: null
        expect(gated).toMatch(/where: \{ id: req\.id, downloadedAt: null \}/);
        // expiry check
        expect(gated).toMatch(/req\.expiresAt && req\.expiresAt < now/);
        // H4 — token ISSUANCE (with the TTL) moved out of the public gated
        // module into the authenticated admin-approval usecase; the anonymous
        // request path no longer mints tokens at all.
        const adminApprove = read('src/app-layer/usecases/trust-center-documents.ts');
        expect(adminApprove).toMatch(/DOWNLOAD_TOKEN_TTL_DAYS/);
        // The public request path must NOT auto-grant a token inline.
        expect(gated).not.toMatch(/status: autoApprove/);
    });

    it('the public gated-doc projection never selects fileRecordId', () => {
        // listPublicTrustCenterDocuments select is label/gated only
        const listBlock = gated.slice(gated.indexOf('listPublicTrustCenterDocuments'), gated.indexOf('AccessRequestInput'));
        expect(listBlock).not.toMatch(/fileRecordId: true/);
    });

    it('the two models carry RLS + tenant indexes', () => {
        const schema = readPrismaSchema();
        expect(schema).toMatch(/model TrustCenterDocument \{/);
        expect(schema).toMatch(/model TrustCenterAccessRequest \{/);
        expect(schema).toMatch(/downloadTokenHash String\?\s+@unique/);
        const mig = readSql('prisma/migrations/20260707150000_trust_center_gated_docs/migration.sql');
        expect(mig).toMatch(/ARRAY\['TrustCenterDocument','TrustCenterAccessRequest'\]/);
        expect(mig).toMatch(/FORCE ROW LEVEL SECURITY/);
    });

    it('the admin request-list projection omits the token hash', () => {
        const admin = read('src/app-layer/usecases/trust-center-documents.ts');
        const listBlock = admin.slice(admin.indexOf('listTrustCenterAccessRequests'), admin.indexOf('ApproveResult'));
        expect(listBlock).not.toMatch(/downloadTokenHash: true/);
    });
});
