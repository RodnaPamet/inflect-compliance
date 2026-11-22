/**
 * Container-start step: decrypt DataSubjectRequest values written while the
 * model was in the field-encryption manifest (#5107).
 *
 *   tsx scripts/decrypt-legacy-dsr-fields.ts      (npm run db:decrypt-legacy-dsr)
 *   node dist/decrypt-legacy-dsr-fields.mjs       (the entrypoint, every start)
 *
 * Non-fatal, like the seeds around it: a value it cannot open is left as
 * ciphertext and counted, and the app still serves every other request.
 */
import { prisma } from '@/lib/prisma';
import { runWithoutRls } from '@/lib/db/rls-middleware';
import { decryptLegacyDsrFields } from '@/lib/security/dsr-legacy-decrypt';

async function main(): Promise<number> {
    const r = await runWithoutRls({ reason: 'admin-script' }, (db) => decryptLegacyDsrFields(db));
    if (r.scanned === 0) {
        console.log('  ✓ No encrypted data-subject-request values remain.');
        return 0;
    }
    console.log(
        `  ${r.undecryptable > 0 ? '⚠' : '✓'} data-subject requests: ${r.decrypted} value(s) decrypted, ` +
            `${r.undecryptable} left as ciphertext (no candidate key opened them), of ${r.scanned} row(s).`,
    );
    return r.undecryptable > 0 ? 1 : 0;
}

main()
    .catch((err) => {
        console.error('❌ Data-subject-request decrypt failed:', err);
        return 1;
    })
    .then(async (code) => {
        await prisma.$disconnect();
        process.exit(code);
    });
