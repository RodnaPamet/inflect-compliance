/**
 * One accept list, one cap, one byte formatter.
 *
 * All three were duplicated across the evidence surfaces, and two of the
 * copies carried comments SAYING they were copies — "Mirrors the evidence
 * upload modal's accept list + hint copy", "mirrors FileDropzone's local
 * helper". Both were accurate when written and neither did anything to keep
 * it true.
 *
 * The formatter is the one that drifted visibly, so it gets the behavioural
 * coverage; the constants get a structural check that no surface has gone
 * back to declaring its own.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    EVIDENCE_ACCEPT,
    EVIDENCE_MAX_FILE_MB,
    EVIDENCE_MAX_FILE_BYTES,
    EVIDENCE_UPLOAD_HINT,
    formatBytes,
} from '@/lib/evidence-upload-limits';
import { evidenceStatusVariant } from '@/app/t/[tenantSlug]/(app)/evidence/evidence-labels';

describe('formatBytes', () => {
    it('renders sub-kilobyte sizes in bytes', () => {
        // The branch EvidenceAddForm's copy had lost: it went straight to
        // KB, so a 500-byte file read "0.5 KB" and an empty-ish file was
        // indistinguishable from a small one.
        expect(formatBytes(0)).toBe('0 B');
        expect(formatBytes(500)).toBe('500 B');
        expect(formatBytes(1023)).toBe('1023 B');
    });

    it('switches to KB at exactly 1024 and MB at exactly 1048576', () => {
        expect(formatBytes(1024)).toBe('1.0 KB');
        expect(formatBytes(1048575)).toBe('1024.0 KB');
        expect(formatBytes(1048576)).toBe('1.0 MB');
    });

    it('renders MB for large files', () => {
        expect(formatBytes(26214400)).toBe('25.0 MB');
    });

    it('renders an em-dash for an absent size rather than "0 B"', () => {
        // FileRecord.size is nullable; "0 B" would assert something false
        // about a file whose size simply was not recorded.
        expect(formatBytes(null)).toBe('—');
        expect(formatBytes(undefined)).toBe('—');
    });
});

describe('the shared upload limits', () => {
    it('derives bytes from MB rather than declaring both', () => {
        expect(EVIDENCE_MAX_FILE_BYTES).toBe(EVIDENCE_MAX_FILE_MB * 1024 * 1024);
    });

    it('states the cap in the hint the surfaces render', () => {
        // The hint and the enforced number drifting apart is the same class
        // of bug one level up: the UI would promise a limit nothing applies.
        expect(EVIDENCE_UPLOAD_HINT).toContain(`${EVIDENCE_MAX_FILE_MB} MB`);
    });

    it('no evidence surface re-declares the accept list', () => {
        const ROOT = path.resolve(__dirname, '../..');
        const files = [
            'src/app/t/[tenantSlug]/(app)/evidence/UploadEvidenceModal.tsx',
            'src/components/evidence/EvidenceUploadSection.tsx',
            'src/components/EvidenceAddForm.tsx',
        ];
        const literal = EVIDENCE_ACCEPT.slice(0, 24); // '.pdf,.jpg,.jpeg,.png,…'
        const offenders = files.filter((f) => {
            const src = fs.readFileSync(path.join(ROOT, f), 'utf8')
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/^\s*\/\/.*$/gm, '');
            return src.includes(literal);
        });
        expect(offenders).toEqual([]);
    });
});

describe('evidence status badge tone', () => {
    it('PENDING_UPLOAD reads as in-flight, not as unknown', () => {
        // The member the detail sheet's copy had lost. It fell through to
        // 'neutral' there while the list showed 'info' — the same row,
        // badged two ways, for the one status that exists only mid-upload
        // and is therefore hardest to catch by looking.
        expect(evidenceStatusVariant('PENDING_UPLOAD')).toBe('info');
    });

    it('maps the persisted statuses to their tones', () => {
        expect(evidenceStatusVariant('DRAFT')).toBe('neutral');
        expect(evidenceStatusVariant('SUBMITTED')).toBe('info');
        expect(evidenceStatusVariant('APPROVED')).toBe('success');
        expect(evidenceStatusVariant('REJECTED')).toBe('error');
        expect(evidenceStatusVariant('NEEDS_REVIEW')).toBe('warning');
    });

    it('falls back to neutral for an unmapped or absent status', () => {
        expect(evidenceStatusVariant('SOME_FUTURE_STATUS')).toBe('neutral');
        expect(evidenceStatusVariant(null)).toBe('neutral');
        expect(evidenceStatusVariant(undefined)).toBe('neutral');
    });
});
