/**
 * The PII fixture corpus is generated, valid, and honest about what it holds.
 *
 * Phase 0.2 of `docs/ai-architecture/presidio.md`. The validators below are
 * written independently of the generator's, so a generator bug cannot certify
 * itself.
 */
import * as fs from 'node:fs';

import { PiiFixtureCorpusSchema, piiCorpusDigest } from '@/lib/ai/pii/evaluation-record';

import {
    PII_CORPUS_HASH_PATH,
    PII_CORPUS_PATH,
    generatePiiCorpus,
    serialisePiiCorpus,
} from '../fixtures/pii/generate';

const committed = fs.readFileSync(PII_CORPUS_PATH, 'utf8');
const corpus = PiiFixtureCorpusSchema.parse(JSON.parse(committed));

function spansOf(type: string): string[] {
    return corpus.cases.flatMap((c) => c.spans.filter((s) => s.type === type).map((s) => c.text.slice(s.start, s.end)));
}

/** ЕГН validity, from the definition: a real date under the century offset, and the weighted checksum. */
function isValidEgn(value: string): boolean {
    if (!/^\d{10}$/.test(value)) return false;
    const d = value.split('').map(Number);
    const weights = [2, 4, 8, 5, 10, 9, 7, 3, 6];
    let check = weights.reduce((acc, w, i) => acc + w * d[i], 0) % 11;
    if (check === 10) check = 0;
    if (check !== d[9]) return false;
    let year = 1900 + Number(value.slice(0, 2));
    let month = Number(value.slice(2, 4));
    if (month > 40) {
        year += 100;
        month -= 40;
    } else if (month > 20) {
        year -= 100;
        month -= 20;
    }
    const day = Number(value.slice(4, 6));
    const date = new Date(Date.UTC(year, month - 1, day));
    return month >= 1 && month <= 12 && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** ISO 13616: move the first four characters to the end, letters to numbers, mod 97 = 1. */
function isValidIban(printed: string): boolean {
    const compact = printed.replace(/ /g, '');
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(compact)) return false;
    const numeric = (compact.slice(4) + compact.slice(0, 4)).replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
    let rem = 0;
    for (const ch of numeric) rem = (rem * 10 + Number(ch)) % 97;
    return rem === 1;
}

describe('PII fixture corpus', () => {
    it('is exactly what the generator produces, so nothing in it was pasted by hand', () => {
        expect(committed).toBe(serialisePiiCorpus(generatePiiCorpus()));
    });

    it('is named by the digest of its exact bytes', () => {
        const [digest, name] = fs.readFileSync(PII_CORPUS_HASH_PATH, 'utf8').trim().split(/\s+/);
        expect(name).toBe('corpus.json');
        expect(digest).toBe(piiCorpusDigest(committed));
    });

    it('carries only valid ЕГН ground truth, every one of which the definition accepts', () => {
        const egns = spansOf('BG_EGN');
        expect(egns.length).toBeGreaterThan(0);
        expect(egns.filter((v) => !isValidEgn(v))).toEqual([]);
    });

    it('holds no valid ЕГН anywhere a refusal or missing-input case says there is nothing to find', () => {
        const unlabelled = corpus.cases.filter((c) => c.spans.length === 0);
        const tenDigitRuns = unlabelled.flatMap((c) => c.text.match(/(?<!\d)\d{10}(?!\d)/g) ?? []);
        // The near-misses are present (or the refusal cases would be testing nothing) …
        expect(tenDigitRuns.length).toBeGreaterThanOrEqual(4);
        // … and none of them is a person's number.
        expect(tenDigitRuns.filter(isValidEgn)).toEqual([]);
    });

    it('carries only IBANs whose check digits are right', () => {
        const ibans = spansOf('IBAN_CODE');
        expect(ibans.length).toBeGreaterThan(0);
        expect(ibans.filter((v) => !isValidIban(v))).toEqual([]);
    });

    it('uses only reserved e-mail domains, which cannot reach anybody', () => {
        const domains = new Set(spansOf('EMAIL_ADDRESS').map((e) => e.split('@')[1]));
        expect([...domains].filter((d) => !/(^|\.)example\.(test|invalid)$/.test(d))).toEqual([]);
    });

    it('uses only Ofcom drama ranges for UK numbers, which are never assigned', () => {
        const uk = spansOf('PHONE_NUMBER').filter((p) => !p.startsWith('+359') && !/^0(2 |[89])/.test(p));
        expect(uk.length).toBeGreaterThan(0);
        expect(uk.filter((p) => !/^(\+44 |0)(20 7946 0\d{3}|7700 900\d{3})$/.test(p))).toEqual([]);
    });

    it('names persons in both scripts, so a Latin-only detector cannot pass', () => {
        const persons = spansOf('PERSON');
        expect(persons.some((p) => /^[Ѐ-ӿ ]+$/.test(p))).toBe(true);
        expect(persons.some((p) => /^[A-Za-z ]+$/.test(p))).toBe(true);
    });
});
