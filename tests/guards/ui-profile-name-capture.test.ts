/**
 * UI roadmap 14b — first/last name capture on the profile page.
 *
 * Users can set a real name so the owner/assignee columns (which read
 * User.name via ownerDisplayName) and the top-bar show a person, not the email
 * local-part. First + last compose into the single User.name field; the update
 * is self-service (session user only).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// At the seam, not per assertion, so a new `expect(read(...))` inherits it.
// String literals are KEPT — masking them would silently empty assertions that
// harvest codes or ids from source. Every path this file reads is a
// TypeScript-alike, re-derived per file rather than assumed from the directory.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => codeOf(fs.readFileSync(path.join(ROOT, p), 'utf8'));

describe('UI-14b — profile name capture', () => {
    it('the profile page mounts <NameEditField>', () => {
        const page = read('src/app/account/profile/page.tsx');
        expect(page).toMatch(/<NameEditField\b/);
        expect(page).toMatch(/initialName=\{session\.user\.name/);
    });

    it('the name-edit form posts first+last to PATCH /api/account/profile', () => {
        const form = read('src/app/account/profile/NameEditField.tsx');
        expect(form).toMatch(/method: 'PATCH'/);
        expect(form).toMatch(/\/api\/account\/profile/);
        expect(form).toMatch(/firstName/);
        expect(form).toMatch(/lastName/);
    });

    it('the route is self-service (session user, no userId param)', () => {
        const route = read('src/app/api/account/profile/route.ts');
        expect(route).toMatch(/export const PATCH/);
        expect(route).toMatch(/getServerSession\(authOptions\)/);
        expect(route).toMatch(/updateOwnDisplayName\(\s*session\.user\.id/);
        // No cross-user write: the handler must not read a userId from params/body.
        expect(route).not.toMatch(/params|userId:\s*z\./);
    });

    it('composeDisplayName + updateOwnDisplayName are the name helpers', () => {
        const lib = read('src/lib/account/profile.ts');
        expect(lib).toMatch(/export function composeDisplayName/);
        expect(lib).toMatch(/export async function updateOwnDisplayName/);
        // Sanitised display name (no raw HTML persisted).
        expect(lib).toMatch(/sanitizePlainText/);
    });
});
