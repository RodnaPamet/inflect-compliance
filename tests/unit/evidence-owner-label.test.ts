/**
 * Evidence has two owner columns, and the UI read the wrong one.
 *
 * `Evidence.owner` is legacy free text; `Evidence.ownerUserId` is the real
 * user FK. Three surfaces WRITE the FK — the edit modal's `UserCombobox`, the
 * bulk "Assign owner" action, and the SoD / notification routing that depends
 * on it — while every READ path rendered the free-text column, and no read
 * path joined the user at all.
 *
 * So `ownerUserId` was write-only from the UI's point of view: assigning an
 * owner appeared to do nothing. Inversely, the create-from-text modal writes
 * the free-text column, which IS displayed. Create filled the visible column;
 * edit filled the invisible one.
 */
import { ownerLabel } from '@/lib/evidence-owner-label';

describe('ownerLabel', () => {
    it('prefers the assigned user over the legacy free-text column', () => {
        // The defect, stated directly: this returned 'typed by hand'.
        expect(
            ownerLabel({ owner: 'typed by hand', ownerUser: { name: 'Ada Lovelace', email: 'ada@x.io' } }),
        ).toBe('Ada Lovelace');
    });

    it('renders an assigned user that has no name via its email', () => {
        // OAuth accounts can carry a null `name`. Falling straight through to
        // the legacy column here would show a stale hand-typed owner for a row
        // that has a real, current assignee.
        expect(ownerLabel({ owner: 'stale', ownerUser: { name: null, email: 'grace@x.io' } })).toBe('grace@x.io');
        expect(ownerLabel({ owner: null, ownerUser: { name: '   ', email: 'grace@x.io' } })).toBe('grace@x.io');
    });

    it('falls back to the legacy column when no user is assigned', () => {
        // Rows created before the FK existed, and rows from the
        // create-from-text modal, have only this.
        expect(ownerLabel({ owner: 'Legacy Owner', ownerUser: null })).toBe('Legacy Owner');
        expect(ownerLabel({ owner: 'Legacy Owner' })).toBe('Legacy Owner');
    });

    it('returns empty when there is genuinely no owner', () => {
        // The caller renders the em-dash, so this must not invent one.
        expect(ownerLabel({})).toBe('');
        expect(ownerLabel({ owner: null, ownerUser: null })).toBe('');
        expect(ownerLabel({ owner: '   ' })).toBe('');
    });
});
