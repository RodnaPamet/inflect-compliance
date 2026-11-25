/**
 * A column sealed outside the encryption extension is sealed and opened ONLY
 * through `sealTenantSecret` / `openTenantSecret`, and only if both rotations
 * reach it (#5942, #5969).
 *
 * `encryptField` seals under the MASTER key (`v1:`). The master-key rotation
 * (`jobs/key-rotation.ts`) re-encrypts only what its lists name, and the
 * per-workspace key rotation (`jobs/tenant-dek-rotation.ts`) likewise. A column
 * sealed anywhere else is never re-encrypted, and retiring
 * `DATA_ENCRYPTION_KEY_PREVIOUS` at the end of a rotation then makes it
 * unreadable. That happened twice: the PII columns (#5070) and every
 * integration's credentials (#5942).
 *
 * So, outside the encryption infrastructure:
 *   - nothing calls `encryptField` or `decryptField` at all;
 *   - every `sealTenantSecret` call writes a column in `TENANT_SEALED_COLUMNS`,
 *     named at the call (`<column>: await sealTenantSecret(`) or through one
 *     local the file then writes as `<column>: <local>`;
 *   - neither helper is imported under another name.
 * A call that names no column fails too: the guard cannot vouch for what it
 * cannot see.
 */
import * as fs from 'fs';
import { repoFiles, repoRelative } from '../helpers/repo-files';
import { codeOf } from '../helpers/source-blocks';
import { TENANT_SEALED_COLUMNS } from '@/lib/security/encrypted-fields';

/**
 * The encryption infrastructure itself, each with what it seals or opens and
 * which list covers it. Not an exemption list for features: a feature that
 * seals a column outside the manifest adds it to `TENANT_SEALED_COLUMNS` and
 * calls `sealTenantSecret`.
 */
const INFRASTRUCTURE: Record<string, string> = {
    'src/lib/security/encryption.ts': 'defines encryptField and decryptField',
    'src/lib/db/encryption-middleware.ts': 'seals and opens ENCRYPTED_FIELDS, which both rotations walk',
    'src/lib/security/pii-middleware.ts': 'seals and opens the PII columns, which the master-key rotation walks',
    'src/lib/security/tenant-keys.ts': 'wraps Tenant.encryptedDek, which the master-key rotation re-wraps',
    'src/lib/security/tenant-sealed.ts': 'seals and opens TENANT_SEALED_COLUMNS, which both rotations walk',
    'src/lib/security/dsr-legacy-decrypt.ts': 'reads legacy PII values for a data-subject export; seals nothing',
    'src/app-layer/jobs/key-rotation.ts': 'the master-key rotation itself',
    'src/lib/security/startup-encryption-check.ts': 'a boot-time round trip of a constant; stores nothing',
};

const SEALED = new Set(Object.values(TENANT_SEALED_COLUMNS).flat());

interface Code {
    file: string;
    code: string;
}

function sources(): Code[] {
    return repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] }).map((abs) => ({
        file: repoRelative(abs),
        code: codeOf(fs.readFileSync(abs, 'utf8')),
    }));
}

function lineOf(code: string, index: number): number {
    return code.slice(0, index).split('\n').length;
}

describe('columns sealed outside the encryption extension', () => {
    const all = sources();
    const features = all.filter((s) => !INFRASTRUCTURE[s.file]);

    it('nothing outside the encryption infrastructure calls encryptField or decryptField', () => {
        const offenders: string[] = [];
        for (const { file, code } of features) {
            const re = /\b(encryptField|decryptField)\s*\(/g;
            let m: RegExpExecArray | null;
            while ((m = re.exec(code)) !== null) offenders.push(`${file}:${lineOf(code, m.index)} calls ${m[1]}`);
        }
        expect(offenders).toEqual([]);
    });

    it('finds the integration-credential writers (the scan is not vacuous)', () => {
        const writers = features.filter((s) => /\bsealTenantSecret\s*\(/.test(s.code)).map((s) => s.file);
        expect(writers).toContain('src/app-layer/usecases/integrations.ts');
        const readers = features.filter((s) => /\bopenTenantSecret\s*\(/.test(s.code)).map((s) => s.file);
        expect(readers).toContain('src/app-layer/usecases/integrations.ts');
    });

    it('every sealTenantSecret call writes a column in TENANT_SEALED_COLUMNS', () => {
        const offenders: string[] = [];
        for (const { file, code } of features) {
            const re = /\bsealTenantSecret\s*\(/g;
            let m: RegExpExecArray | null;
            while ((m = re.exec(code)) !== null) {
                const before = code.slice(Math.max(0, m.index - 120), m.index);
                const named = /([A-Za-z_$][\w$]*)\s*[:=]\s*(?:await\s+)?$/.exec(before)?.[1] ?? null;
                const ok =
                    named !== null &&
                    (SEALED.has(named) ||
                        [...SEALED].some((col) => new RegExp(`\\b${col}\\s*:\\s*${named}\\b`).test(code)));
                if (!ok) offenders.push(`${file}:${lineOf(code, m.index)} seals ${named ?? '<an unnamed value>'}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    it('no module imports an encryption helper under another name', () => {
        const aliased = all
            .filter(({ code }) => /\b(encryptField|decryptField|sealTenantSecret|openTenantSecret)\s+as\s+\w/.test(code))
            .map((s) => s.file);
        expect(aliased).toEqual([]);
    });

    it('both rotations walk TENANT_SEALED_COLUMNS', () => {
        for (const job of ['src/app-layer/jobs/key-rotation.ts', 'src/app-layer/jobs/tenant-dek-rotation.ts']) {
            const code = all.find((s) => s.file === job)?.code ?? '';
            expect(code).toMatch(/Object\.entries\(TENANT_SEALED_COLUMNS\)/);
        }
    });

    it('every infrastructure entry still exists', () => {
        const files = new Set(all.map((s) => s.file));
        for (const rel of Object.keys(INFRASTRUCTURE)) expect(files).toContain(rel);
    });
});
