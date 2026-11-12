/**
 * #5292 — an audit diff must never carry an Epic B encrypted field's PLAINTEXT.
 *
 * ═══ THE DEFECT ═══
 *
 * The audit extension is the INNERMOST layer (`src/lib/prisma.ts`:
 * `withPiiEncryption(withEncryption(withSoftDelete(base.$extends(audit))))`),
 * so the `data` it is handed and the `result` it sees are already CIPHERTEXT.
 *
 * Its prior-state read is not. `priorStateReaderFor(tx)` (db-context.ts) calls
 * `findFirst` on the `tx` of the FULLY EXTENDED client — `p = customPrisma ||
 * prisma` — and `findFirst` is on the encryption extension's decrypting list.
 * So `priorState` arrives DECRYPTED.
 *
 * Two things follow, and both are real:
 *
 *  1. `before: redactSensitiveFields(pick(priorState, changedFields))` writes
 *     the old PLAINTEXT of `Risk.treatmentNotes`, `TaskComment.body`,
 *     `PolicyVersion.contentText` and the other 53 manifest models into
 *     `AuditLog.diffJson` — a column `encrypted-fields.ts` deliberately leaves
 *     unencrypted ("`AuditLog.*` — append-only hash-chained audit trail").
 *     Epic B's at-rest contract is defeated for every PRIOR value.
 *     `redactSensitiveFields` does not save it: it redacts by NAME, and
 *     `description` / `body` / `notes` are not secret-shaped names.
 *
 *  2. `sameStoredValue(priorState[f], data[f])` compares PLAINTEXT against
 *     CIPHERTEXT, which never matches — so every encrypted field in a payload
 *     is reported as changed even when the user changed nothing. That is the
 *     exact "fires on everything" failure #2881 set out to remove, reintroduced
 *     for the encrypted subset.
 *
 * ═══ WHAT THE TITLE GETS WRONG, AND WHY IT IS RECORDED HERE ═══
 *
 * The issue's title says this reaches `detailsJson` and is streamed to the
 * tenant SIEM. It does not. The extension copies only `changedFields` and
 * `after` into `detailsJson`, and `after` is built from `result`, which is
 * ciphertext. So the SIEM half is a false alarm and only the at-rest half is
 * real. Written down because the next reader will have the title in hand.
 *
 * ═══ WHAT THE AUDIT LAYER CAN HONESTLY SAY ═══
 *
 * Sitting below encryption it sees ciphertext in, plaintext out, and cannot
 * compare them. So it must not claim these fields changed, and must not record
 * their values. It can say the write NAMED them. That is the same
 * NAMED-vs-COMPARED distinction `changedFieldsAreDiffed` already draws, applied
 * per field.
 */
import { buildDiffJson } from '@/lib/prisma';
import { ENCRYPTED_FIELDS } from '@/lib/security/encrypted-fields';

/** A real manifest entry, so this cannot pass against an invented model. */
const RISK_ENCRYPTED = ENCRYPTED_FIELDS.Risk;

describe('the manifest entry this test stands on', () => {
    it('Risk really does encrypt treatmentNotes (else every case below is vacuous)', () => {
        expect(RISK_ENCRYPTED).toContain('treatmentNotes');
    });
});

describe('an audit diff never carries an encrypted field’s plaintext (#5292)', () => {
    it('keeps the prior PLAINTEXT out of `before`', () => {
        const diff = buildDiffJson(
            'update',
            { treatmentNotes: 'v2:AbCdEf==', title: 'After' },   // ciphertext, as the extension sees it
            { treatmentNotes: 'v2:AbCdEf==', title: 'After' },
            { treatmentNotes: 'the old plaintext note', title: 'Before' }, // decrypted by the read
            'Risk',
        );

        expect(JSON.stringify(diff)).not.toContain('the old plaintext note');
        expect((diff?.before as Record<string, unknown>)?.treatmentNotes).toBeUndefined();
    });

    it('keeps the ciphertext out of `after` too — an audit row is not a second copy', () => {
        const diff = buildDiffJson(
            'update',
            { treatmentNotes: 'v2:AbCdEf==' },
            { treatmentNotes: 'v2:AbCdEf==' },
            { treatmentNotes: 'old' },
            'Risk',
        );
        expect((diff?.after as Record<string, unknown>)?.treatmentNotes).toBeUndefined();
    });

    it('does not CLAIM an encrypted field changed — it cannot know', () => {
        // plaintext vs ciphertext never compares equal, so the old code reported
        // `treatmentNotes` as changed on every write that named it.
        const diff = buildDiffJson(
            'update',
            { treatmentNotes: 'v2:AbCdEf==', title: 'Same' },
            { treatmentNotes: 'v2:AbCdEf==', title: 'Same' },
            { treatmentNotes: 'unchanged in truth', title: 'Same' },
            'Risk',
        );
        expect(diff?.changedFields ?? []).not.toContain('treatmentNotes');
    });

    it('still SAYS the write named the field, rather than hiding it', () => {
        // Dropping it silently would make an audit row describe less than it
        // knows. Named-not-compared is the honest report.
        const diff = buildDiffJson(
            'update',
            { treatmentNotes: 'v2:AbCdEf==' },
            { treatmentNotes: 'v2:AbCdEf==' },
            { treatmentNotes: 'old' },
            'Risk',
        );
        expect(diff?.undiffableFields).toStrictEqual(['treatmentNotes']);
    });

    it('a write that names ONLY encrypted fields still produces a row', () => {
        // `changedFields` would be empty, and the old code returns null on
        // empty. The write happened; the trail must not be silent about it.
        const diff = buildDiffJson(
            'update',
            { treatmentNotes: 'v2:AbCdEf==' },
            { treatmentNotes: 'v2:AbCdEf==' },
            { treatmentNotes: 'old' },
            'Risk',
        );
        expect(diff).not.toBeNull();
    });

    it('non-encrypted fields on the same model are unaffected', () => {
        // The narrowing must not cost the diff its real job.
        const diff = buildDiffJson(
            'update',
            { treatmentNotes: 'v2:AbCdEf==', title: 'After' },
            { treatmentNotes: 'v2:AbCdEf==', title: 'After' },
            { treatmentNotes: 'old', title: 'Before' },
            'Risk',
        );
        expect(diff?.changedFields).toStrictEqual(['title']);
        expect((diff?.before as Record<string, unknown>)?.title).toBe('Before');
    });

    it('a model with NO manifest entry behaves exactly as before', () => {
        // The positive control for the narrowing: it must not leak into models
        // that have no encrypted fields.
        const diff = buildDiffJson(
            'update',
            { department: 'Eng' },
            { department: 'Eng' },
            { department: 'Sales' },
            'Employee',
        );
        expect(diff?.changedFields).toStrictEqual(['department']);
        expect((diff?.before as Record<string, unknown>)?.department).toBe('Sales');
    });

    it('and so does a call that passes NO model — the existing call shape', () => {
        // 300+ existing assertions call the 4-arg form. It must not change.
        const diff = buildDiffJson(
            'update',
            { department: 'Eng' },
            { department: 'Eng' },
            { department: 'Sales' },
        );
        expect(diff?.changedFields).toStrictEqual(['department']);
        expect((diff?.before as Record<string, unknown>)?.department).toBe('Sales');
    });
});
