/**
 * Every column sealed with `encryptField` is one the master-key rotation reaches.
 *
 * `encryptField` seals under the MASTER key (`v1:`). The rotation
 * (`jobs/key-rotation.ts`) re-encrypts only what its lists name:
 * `ENCRYPTED_FIELDS` (through the encryption extension), the PII columns
 * (through the PII middleware) and `KEK_SEALED_COLUMNS` (explicit writes).
 * A column sealed anywhere else is never re-encrypted, and retiring
 * `DATA_ENCRYPTION_KEY_PREVIOUS` at the end of a rotation then makes it
 * unreadable. That happened twice: the PII columns (#5070) and every
 * integration's credentials (#5942).
 *
 * So every call site outside the encryption infrastructure must name the
 * column it writes (`<column>: encryptField(` or `<column> = encryptField(`),
 * and that column must be in `KEK_SEALED_COLUMNS`. A call that names no column
 * fails too: the guard cannot vouch for what it cannot see.
 */
import * as fs from 'fs';
import { repoFiles, repoRelative } from '../helpers/repo-files';
import { codeOf } from '../helpers/source-blocks';
import { KEK_SEALED_COLUMNS } from '@/lib/security/encrypted-fields';

/**
 * The encryption infrastructure itself, each with the list that covers what it
 * seals. Not an exemption list for features: a feature that seals a column adds
 * the column to `KEK_SEALED_COLUMNS`.
 */
const INFRASTRUCTURE: Record<string, string> = {
    'src/lib/security/encryption.ts': 'defines encryptField',
    'src/lib/db/encryption-middleware.ts': 'seals ENCRYPTED_FIELDS, which the rotation walks',
    'src/lib/security/pii-middleware.ts': 'seals the PII columns, which the rotation walks',
    'src/lib/security/tenant-keys.ts': 'wraps Tenant.encryptedDek, which the rotation re-wraps',
    'src/app-layer/jobs/key-rotation.ts': 'the rotation itself',
    'src/lib/security/startup-encryption-check.ts': 'a boot-time round trip of a constant; stores nothing',
};

const SEALED = new Set(Object.values(KEK_SEALED_COLUMNS).flat());

interface CallSite {
    file: string;
    line: number;
    column: string | null;
}

function callSites(): CallSite[] {
    const out: CallSite[] = [];
    for (const abs of repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] })) {
        const rel = repoRelative(abs);
        if (INFRASTRUCTURE[rel]) continue;
        const code = codeOf(fs.readFileSync(abs, 'utf8'));
        const re = /\bencryptField\s*\(/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(code)) !== null) {
            const before = code.slice(Math.max(0, m.index - 120), m.index);
            const named = /([A-Za-z_$][\w$]*)\s*[:=]\s*$/.exec(before);
            out.push({
                file: rel,
                line: code.slice(0, m.index).split('\n').length,
                column: named ? named[1] : null,
            });
        }
    }
    return out;
}

describe('a column sealed with encryptField is one the master-key rotation reaches', () => {
    const sites = callSites();

    it('finds the integration-credential writers (the scan is not vacuous)', () => {
        expect(sites.length).toBeGreaterThan(0);
        expect(sites.some((s) => s.file === 'src/app-layer/usecases/integrations.ts')).toBe(true);
    });

    it('every call site names its column, and the column is in KEK_SEALED_COLUMNS', () => {
        const offenders = sites
            .filter((s) => s.column === null || !SEALED.has(s.column))
            .map((s) => `${s.file}:${s.line} seals ${s.column ?? '<an unnamed value>'}`);
        expect(offenders).toEqual([]);
    });

    it('no module imports encryptField under another name', () => {
        const aliased = repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] })
            .filter((abs) => /\bencryptField\s+as\s+\w/.test(codeOf(fs.readFileSync(abs, 'utf8'))))
            .map(repoRelative);
        expect(aliased).toEqual([]);
    });

    it('every infrastructure entry still exists', () => {
        for (const rel of Object.keys(INFRASTRUCTURE)) {
            expect(repoFiles({ under: rel.split('/').slice(0, -1).join('/') }).map(repoRelative)).toContain(rel);
        }
    });
});
