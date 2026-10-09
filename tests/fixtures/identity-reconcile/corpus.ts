/**
 * The labelled corpus every reconciliation step is measured against.
 *
 * ‾‾‾ ENTIRELY SYNTHETIC ‾‾‾
 *
 * No real name, no real address, no national identifier, no real employee number.
 * Every address is under `example.test` or `example.invalid`, which are reserved
 * and cannot resolve. The Cyrillic surnames used are the equivalents of Smith and
 * Jones — generic by construction. This matters beyond hygiene: the corpus is
 * committed, read in pull requests, and Step 6b sends a residue-shaped subset to a
 * model. A corpus carrying one real person would make all three a disclosure.
 *
 * ‾‾‾ WHAT A CASE IS ‾‾‾
 *
 * A legacy account, the HR slice and directory slice visible at the time, and the
 * outcome a correct engine must reach. `expected.employeeId` is the person it must
 * reach it ABOUT — `null` where no employee is the right answer.
 *
 * Step 3a (this step) asserts only the NORMAL FORMS: that the library turns each
 * case's inputs into the shapes recorded here. The outcomes are the contract for
 * Step 3b's engine and its 100% precision ratchet, and are deliberately written
 * down before the engine exists so the engine is measured against a target it did
 * not choose.
 *
 * ‾‾‾ WHY `SUGGESTED` APPEARS SO OFTEN ‾‾‾
 *
 * Only a strong deterministic signal may produce `LINKED`. Transliteration,
 * similarity and naming conventions reach `SUGGESTED` and stop there, because a
 * person confirms every link. A corpus where most Cyrillic cases were `LINKED`
 * would be describing a different product.
 */

export type Outcome = 'LINKED' | 'SUGGESTED' | 'AMBIGUOUS' | 'UNMATCHED' | 'NON_PERSON';

export type CorpusCategory =
    | 'last-first-order'
    | 'initials'
    | 'numeric-suffix'
    | 'domain-alias'
    | 'cyrillic-streamlined'
    | 'cyrillic-traditional'
    | 'username-reuse-after-termination'
    | 'rekeyed-email'
    | 'contractor'
    | 'service-account'
    | 'yot-and-yo'
    | 'mixed-script'
    | 'pathological-input'
    | 'alias-on-departed-employee';

export interface LegacyAccountSlice {
    readonly accountKey: string;
    readonly displayName?: string | null;
    readonly email?: string | null;
    readonly department?: string | null;
    readonly title?: string | null;
    readonly createdAt?: string | null;
    readonly status?: string | null;
}

export interface EmployeeSlice {
    readonly id: string;
    readonly givenName?: string | null;
    readonly familyName?: string | null;
    readonly fullName: string;
    readonly workEmail?: string | null;
    readonly employeeNumber?: string | null;
    readonly status: 'ACTIVE' | 'TERMINATED';
    readonly startDate?: string | null;
    readonly endDate?: string | null;
    readonly department?: string | null;
}

export interface DirectoryAccountSlice {
    readonly connectionId: string;
    readonly email: string;
    readonly samAccountName?: string | null;
    readonly userPrincipalName?: string | null;
    /** Whether the link is fresh and uncontradicted — the bridge requires both. */
    readonly linkFresh: boolean;
    readonly linkedEmployeeId: string | null;
}

export interface CorpusCase {
    readonly id: string;
    readonly category: CorpusCategory;
    /** What this case exists to prove. Read in a failure message. */
    readonly why: string;
    readonly account: LegacyAccountSlice;
    readonly hr: readonly EmployeeSlice[];
    readonly directory: readonly DirectoryAccountSlice[];
    /**
     * Confirmed aliases in force for this case.
     *
     * Added because the corpus could not EXPRESS an alias at all — every
     * consumer passed `aliases: []`, so no case could ever exercise the one
     * signal that links an account on its own. A fixture that cannot produce the
     * input is green about it forever, and that is how the departed-employee
     * defect survived Steps 3b and 4a (see #3346).
     */
    readonly aliases?: readonly { readonly accountKey: string; readonly employeeId: string }[];
    readonly expected: { readonly outcome: Outcome; readonly employeeId: string | null };
    /** Normal forms Step 3a asserts directly. */
    readonly normalForms?: {
        readonly emailKey?: string | null;
        readonly emailUntagged?: string | null;
        readonly nameGiven?: string | null;
        readonly nameFamily?: string | null;
        readonly usernameTokens?: readonly string[];
        readonly employeeNumber?: string | null;
        /** A romanisation that MUST appear among the token's variants. */
        readonly translitContains?: readonly string[];
    };
}

const active = (id: string, fullName: string, extra: Partial<EmployeeSlice> = {}): EmployeeSlice => ({
    id, fullName, status: 'ACTIVE', startDate: '2020-01-06', ...extra,
});

/**
 * A departed employee. `endDate` is required rather than defaulted: a
 * TERMINATED record with no end date cannot be distinguished from a data fault,
 * and the temporal rules this corpus exercises all read it.
 */
const departed = (
    id: string,
    fullName: string,
    endDate: string,
    extra: Partial<EmployeeSlice> = {}
): EmployeeSlice => ({
    id, fullName, status: 'TERMINATED', startDate: '2020-01-06', endDate, ...extra,
});

export const CORPUS: readonly CorpusCase[] = [
    // ‾‾‾ Last, First ‾‾‾
    {
        id: 'lf-01',
        category: 'last-first-order',
        why: 'A legacy directory stores `Last, First` about as often as not; guessing from token order alone is backwards for half the population.',
        account: { accountKey: 'jjones', displayName: 'Jones, Jamie', email: 'jamie.jones@example.test' },
        hr: [active('e-100', 'Jamie Jones', { givenName: 'Jamie', familyName: 'Jones', workEmail: 'jamie.jones@example.test' })],
        directory: [],
        expected: { outcome: 'LINKED', employeeId: 'e-100' },
        normalForms: { nameGiven: 'Jamie', nameFamily: 'Jones', emailKey: 'jamie.jones@example.test' },
    },
    {
        id: 'lf-02',
        category: 'last-first-order',
        why: 'A trailing comma is punctuation, not a structure — parsing it as `Last, First` would swap a name with nothing.',
        account: { accountKey: 'kpatel', displayName: 'Kiran Patel,' },
        hr: [active('e-101', 'Kiran Patel', { givenName: 'Kiran', familyName: 'Patel' })],
        directory: [],
        expected: { outcome: 'SUGGESTED', employeeId: 'e-101' },
        normalForms: { nameGiven: 'Kiran', nameFamily: 'Patel' },
    },

    // ‾‾‾ Initials ‾‾‾
    {
        id: 'in-01',
        category: 'initials',
        why: 'An initial is a weak signal: `J Jones` matches both Jamie and Jordan Jones, so the engine must refuse to pick.',
        account: { accountKey: 'jjones2', displayName: 'J Jones' },
        hr: [
            active('e-100', 'Jamie Jones', { givenName: 'Jamie', familyName: 'Jones' }),
            active('e-102', 'Jordan Jones', { givenName: 'Jordan', familyName: 'Jones' }),
        ],
        directory: [],
        expected: { outcome: 'AMBIGUOUS', employeeId: null },
        normalForms: { nameGiven: 'J', nameFamily: 'Jones' },
    },

    // ‾‾‾ Numeric suffix ‾‾‾
    {
        id: 'ns-01',
        category: 'numeric-suffix',
        why: 'A trailing counter is a disambiguator, not part of the name — but it must not be stripped from an all-numeric identifier.',
        account: { accountKey: 'kpatel3', displayName: 'Kiran Patel' },
        hr: [active('e-101', 'Kiran Patel', { givenName: 'Kiran', familyName: 'Patel' })],
        directory: [],
        expected: { outcome: 'SUGGESTED', employeeId: 'e-101' },
        normalForms: { usernameTokens: ['kpatel'] },
    },
    {
        id: 'ns-02',
        category: 'numeric-suffix',
        why: 'An all-numeric login is an identifier; splitting it into a stem and a counter invents a name that is not there.',
        account: { accountKey: '004711', displayName: null },
        hr: [active('e-103', 'Sam Okafor', { employeeNumber: '4711' })],
        directory: [],
        expected: { outcome: 'LINKED', employeeId: 'e-103' },
        normalForms: { usernameTokens: ['004711'], employeeNumber: '4711' },
    },

    // ‾‾‾ Domain aliases ‾‾‾
    {
        id: 'da-01',
        category: 'domain-alias',
        why: 'Domain equivalence informs a suggestion and never the key: emailKey is what the JML chain joins on, byte for byte. The two domains here are REAL because they are the data under test — an alias pair cannot be demonstrated with reserved domains — so the local part is an unmistakable fixture marker and the hygiene test permits exactly the table own keys and values.',
        account: { accountKey: 'tlee', email: 'zz-corpus-tess@googlemail.com' },
        hr: [active('e-104', 'Tess Lee', { workEmail: 'zz-corpus-tess@gmail.com' })],
        directory: [],
        expected: { outcome: 'SUGGESTED', employeeId: 'e-104' },
        normalForms: { emailUntagged: 'zz-corpus-tess@gmail.com' },
    },
    {
        id: 'da-02',
        category: 'domain-alias',
        why: 'A `+tag` is a routing feature, not an identity — one mailbox, so an exact-email match still stands.',
        account: { accountKey: 'tlee2', email: 'tess.lee+legacy@example.test' },
        hr: [active('e-104', 'Tess Lee', { workEmail: 'tess.lee@example.test' })],
        directory: [],
        expected: { outcome: 'SUGGESTED', employeeId: 'e-104' },
        normalForms: { emailUntagged: 'tess.lee@example.test' },
    },

    // ‾‾‾ Cyrillic, both schemes ‾‾‾
    {
        id: 'cy-01',
        category: 'cyrillic-streamlined',
        why: 'The HR row is romanised by the 2009 law; the legacy row is Cyrillic. Transliteration reaches SUGGESTED and never LINKED.',
        account: { accountKey: 'iivanov', displayName: 'Иван Иванов' },
        hr: [active('e-200', 'Ivan Ivanov', { givenName: 'Ivan', familyName: 'Ivanov' })],
        directory: [],
        expected: { outcome: 'SUGGESTED', employeeId: 'e-200' },
        normalForms: { translitContains: ['Ivan', 'Ivanov'] },
    },
    {
        id: 'cy-02',
        category: 'cyrillic-traditional',
        why: 'The two schemes disagree on щ: the law gives Shterbanov, the traditional scheme Shcherbanov. Both must be candidates.',
        account: { accountKey: 'ashterbanov', displayName: 'Щербанов, Асен' },
        hr: [active('e-201', 'Asen Shcherbanov', { givenName: 'Asen', familyName: 'Shcherbanov' })],
        directory: [],
        expected: { outcome: 'SUGGESTED', employeeId: 'e-201' },
        normalForms: { nameFamily: 'Щербанов', translitContains: ['Shterbanov', 'Shcherbanov'] },
    },
    {
        id: 'cy-03',
        category: 'cyrillic-streamlined',
        why: "The law's word-final rule: София is Sofia, not Sofiya. A scheme that contracts nothing would miss the HR spelling.",
        account: { accountKey: 'sdimitrova', displayName: 'София Димитрова' },
        hr: [active('e-202', 'Sofia Dimitrova', { givenName: 'Sofia', familyName: 'Dimitrova' })],
        directory: [],
        expected: { outcome: 'SUGGESTED', employeeId: 'e-202' },
        normalForms: { translitContains: ['Sofia', 'Sofiya'] },
    },
    {
        id: 'cy-04',
        category: 'cyrillic-streamlined',
        why: 'Ъ maps to A and is never dropped. A library that deletes it renders Ъгълов as "glov", which no human writes.',
        account: { accountKey: 'bagalov', displayName: 'Борис Ъгълов' },
        hr: [active('e-203', 'Boris Agalov', { givenName: 'Boris', familyName: 'Agalov' })],
        directory: [],
        expected: { outcome: 'SUGGESTED', employeeId: 'e-203' },
        normalForms: { translitContains: ['Agalov'] },
    },

    // ‾‾‾ й and ё ‾‾‾
    {
        id: 'yo-01',
        category: 'yot-and-yo',
        why: 'Transliteration must run before diacritic folding: fold first and Йордан becomes Iordan instead of Yordan.',
        account: { accountKey: 'yjordanov', displayName: 'Йордан Йорданов' },
        hr: [active('e-210', 'Yordan Yordanov', { givenName: 'Yordan', familyName: 'Yordanov' })],
        directory: [],
        expected: { outcome: 'SUGGESTED', employeeId: 'e-210' },
        normalForms: { translitContains: ['Yordan', 'Yordanov'] },
    },
    {
        id: 'yo-02',
        category: 'yot-and-yo',
        why: 'Николай ends in й: Nikolay, not Nikolai. The same ordering bug produces the wrong final letter.',
        account: { accountKey: 'npetrov', displayName: 'Николай Петров' },
        hr: [active('e-211', 'Nikolay Petrov', { givenName: 'Nikolay', familyName: 'Petrov' })],
        directory: [],
        expected: { outcome: 'SUGGESTED', employeeId: 'e-211' },
        normalForms: { translitContains: ['Nikolay', 'Petrov'] },
    },
    {
        id: 'yo-03',
        category: 'yot-and-yo',
        why: 'A Russian ё in a Bulgarian system. It is not in the Bulgarian alphabet, so it must pass through rather than silently become e.',
        account: { accountKey: 'sfedorov', displayName: 'Фёдоров, Семён' },
        hr: [active('e-212', 'Semyon Fedorov', { givenName: 'Semyon', familyName: 'Fedorov' })],
        directory: [],
        expected: { outcome: 'UNMATCHED', employeeId: null },
        normalForms: { nameFamily: 'Фёдоров' },
    },

    // ‾‾‾ Mixed script ‾‾‾
    {
        id: 'ms-01',
        category: 'mixed-script',
        why: 'A Latin name typed through a Cyrillic keyboard. Folding the look-alike recovers the intent; a purely Cyrillic token must never be folded.',
        account: { accountKey: 'ivanov', displayName: `Iv${'\u0430'}nov, Ivan` },
        hr: [active('e-200', 'Ivan Ivanov', { givenName: 'Ivan', familyName: 'Ivanov' })],
        directory: [],
        expected: { outcome: 'SUGGESTED', employeeId: 'e-200' },
        normalForms: { translitContains: ['Ivanov'] },
    },

    // ‾‾‾ Username reuse across a termination ‾‾‾
    {
        id: 'ur-01',
        category: 'username-reuse-after-termination',
        why: 'The login was reissued after a leaver. The account postdates the first holder\'s end date, which is a VETO rather than a tie-break.',
        account: { accountKey: 'mray', displayName: 'Morgan Ray', createdAt: '2024-03-01' },
        hr: [
            { id: 'e-300', fullName: 'Max Ray', givenName: 'Max', familyName: 'Ray', status: 'TERMINATED', startDate: '2019-02-01', endDate: '2023-11-30' },
            active('e-301', 'Morgan Ray', { givenName: 'Morgan', familyName: 'Ray', startDate: '2024-02-01' }),
        ],
        directory: [],
        expected: { outcome: 'SUGGESTED', employeeId: 'e-301' },
        normalForms: { nameGiven: 'Morgan', nameFamily: 'Ray' },
    },

    // ‾‾‾ Re-keyed email ‾‾‾
    {
        id: 'rk-01',
        category: 'rekeyed-email',
        why: 'The person was re-keyed in HR: same human, new record. The strong signal points at the TERMINATED row, so the rule yields SUGGESTED, never LINKED.',
        account: { accountKey: 'aold', email: 'ada.old@example.test', displayName: 'Ada Nwosu' },
        hr: [
            { id: 'e-400', fullName: 'Ada Nwosu', workEmail: 'ada.old@example.test', status: 'TERMINATED', startDate: '2018-05-01', endDate: '2024-01-31' },
            active('e-401', 'Ada Nwosu', { workEmail: 'ada.nwosu@example.test', startDate: '2024-02-01' }),
        ],
        directory: [],
        expected: { outcome: 'SUGGESTED', employeeId: 'e-401' },
        normalForms: { emailKey: 'ada.old@example.test' },
    },

    // ‾‾‾ Contractor ‾‾‾
    {
        id: 'co-01',
        category: 'contractor',
        why: 'Not in HR at all. EXTERNAL is a reviewer decision with a justification and an expiry, not a match the engine may invent.',
        account: { accountKey: 'cjoshi', displayName: 'Chandra Joshi (contractor)', email: 'cjoshi@vendor.example.invalid' },
        hr: [active('e-100', 'Jamie Jones', { givenName: 'Jamie', familyName: 'Jones' })],
        directory: [],
        expected: { outcome: 'UNMATCHED', employeeId: null },
        normalForms: { nameGiven: 'Chandra', nameFamily: 'Joshi' },
    },

    // ‾‾‾ Service accounts ‾‾‾
    {
        id: 'sa-01',
        category: 'service-account',
        why: 'NON_PERSON is decided BEFORE matching, so svc_ accounts never bury real leavers in the orphan list.',
        account: { accountKey: 'svc_backup', displayName: null, email: null },
        hr: [active('e-100', 'Jamie Jones')],
        directory: [],
        expected: { outcome: 'NON_PERSON', employeeId: null },
        normalForms: { usernameTokens: ['svc', 'backup'] },
    },
    {
        id: 'sa-02',
        category: 'service-account',
        why: 'A shared function account with no name field. The absence of a name is itself a NON_PERSON signal.',
        account: { accountKey: 'batch_user', displayName: null },
        hr: [active('e-100', 'Jamie Jones')],
        directory: [],
        expected: { outcome: 'NON_PERSON', employeeId: null },
        normalForms: { usernameTokens: ['batch', 'user'] },
    },
    {
        id: 'sa-03',
        category: 'service-account',
        why: 'A human whose name merely CONTAINS a service-ish token must not be classified NON_PERSON — the control for sa-01.',
        account: { accountKey: 'bsvcic', displayName: 'Bea Svcic' },
        hr: [active('e-105', 'Bea Svcic', { givenName: 'Bea', familyName: 'Svcic' })],
        directory: [],
        expected: { outcome: 'SUGGESTED', employeeId: 'e-105' },
        normalForms: { nameGiven: 'Bea', nameFamily: 'Svcic' },
    },

    // ‾‾‾ The directory bridge ‾‾‾
    {
        id: 'db-01',
        category: 'last-first-order',
        why: 'A fresh, uncontradicted directory link whose sAMAccountName matches exactly one account is a STRONG signal — the one path to LINKED without an email or employee number.',
        account: { accountKey: 'jjones', displayName: 'Jones, Jamie' },
        hr: [active('e-100', 'Jamie Jones', { givenName: 'Jamie', familyName: 'Jones' })],
        directory: [{ connectionId: 'c-1', email: 'jamie.jones@example.test', samAccountName: 'jjones', linkFresh: true, linkedEmployeeId: 'e-100' }],
        expected: { outcome: 'LINKED', employeeId: 'e-100' },
    },
    {
        id: 'db-02',
        category: 'last-first-order',
        why: 'The same sAMAccountName in two directory connections produces NO bridge: two accounts called jjones in different domains are two people until someone says otherwise.',
        account: { accountKey: 'jjones', displayName: 'Jones, Jamie' },
        hr: [
            active('e-100', 'Jamie Jones', { givenName: 'Jamie', familyName: 'Jones' }),
            active('e-102', 'Jordan Jones', { givenName: 'Jordan', familyName: 'Jones' }),
        ],
        directory: [
            { connectionId: 'c-1', email: 'jamie.jones@example.test', samAccountName: 'jjones', linkFresh: true, linkedEmployeeId: 'e-100' },
            { connectionId: 'c-2', email: 'jordan.jones@example.test', samAccountName: 'jjones', linkFresh: true, linkedEmployeeId: 'e-102' },
        ],
        expected: { outcome: 'AMBIGUOUS', employeeId: null },
    },
    {
        id: 'db-03',
        category: 'last-first-order',
        why: 'A stale link is not a bridge. findLeaverCandidates applies the same freshness predicate, and an expired link is how a departed account keeps looking covered.',
        account: { accountKey: 'jjones', displayName: 'Jones, Jamie' },
        hr: [active('e-100', 'Jamie Jones', { givenName: 'Jamie', familyName: 'Jones' })],
        directory: [{ connectionId: 'c-1', email: 'jamie.jones@example.test', samAccountName: 'jjones', linkFresh: false, linkedEmployeeId: 'e-100' }],
        expected: { outcome: 'SUGGESTED', employeeId: 'e-100' },
    },

    // ‾‾‾ Pathological input ‾‾‾
    {
        id: 'pa-01',
        category: 'pathological-input',
        why: 'Unbalanced brackets: a naive nested quantifier over a class that also matches the delimiter backtracks quadratically here.',
        account: { accountKey: 'px1', displayName: '('.repeat(240) },
        hr: [active('e-100', 'Jamie Jones')],
        directory: [],
        expected: { outcome: 'UNMATCHED', employeeId: null },
    },
    {
        id: 'pa-02',
        category: 'pathological-input',
        why: 'A long delimiter run. The username splitter must stay linear and bound its token count.',
        account: { accountKey: `${'a.'.repeat(240)}a`, displayName: null },
        hr: [active('e-100', 'Jamie Jones')],
        directory: [],
        expected: { outcome: 'UNMATCHED', employeeId: null },
    },
    {
        id: 'pa-03',
        category: 'pathological-input',
        why: 'Invisible characters in a display name. They are stripped for comparison, never used to make two different names look like one.',
        account: { accountKey: 'px3', displayName: `Jamie${'\u200B'}${'\u202E'} Jones` },
        hr: [active('e-100', 'Jamie Jones', { givenName: 'Jamie', familyName: 'Jones' })],
        directory: [],
        expected: { outcome: 'SUGGESTED', employeeId: 'e-100' },
        normalForms: { nameGiven: 'Jamie', nameFamily: 'Jones' },
    },

    // ‾‾‾ An alias whose person has left ‾‾‾
    //
    // The three together pin the branch from both sides. Case `aod-03` is the
    // one that stops a future change from "fixing" the leaver case by removing
    // the terminated downgrade altogether.
    {
        id: 'aod-01',
        category: 'alias-on-departed-employee',
        why: 'An alias is a decision a person made, not an inference. When its employee leaves with no successor the terminated row is the CORRECT answer — and a LINKED is acted on by later steps where a SUGGESTED waits in a queue, so downgrading here stops the account being reported as a leaver at the one moment it matters.',
        account: { accountKey: 'mray', displayName: 'Max Ray' },
        hr: [departed('e-900', 'Max Ray', '2026-08-31', { givenName: 'Max', familyName: 'Ray' })],
        directory: [],
        aliases: [{ accountKey: 'mray', employeeId: 'e-900' }],
        expected: { outcome: 'LINKED', employeeId: 'e-900' },
    },
    {
        id: 'aod-02',
        category: 'alias-on-departed-employee',
        why: 'With a re-keyed successor the alias IS doubtful — the person is still here under a new row — so the downgrade is right and points at the successor. Revalidation suspends this case before a run sees it; the engine must still be correct when called without it.',
        account: { accountKey: 'nwosu', displayName: 'Ada Nwosu' },
        hr: [
            departed('e-901', 'Ada Nwosu', '2026-01-31', { givenName: 'Ada', familyName: 'Nwosu' }),
            active('e-902', 'Ada Nwosu', { givenName: 'Ada', familyName: 'Nwosu', startDate: '2026-03-01' }),
        ],
        directory: [],
        aliases: [{ accountKey: 'nwosu', employeeId: 'e-901' }],
        expected: { outcome: 'SUGGESTED', employeeId: 'e-902' },
    },
    {
        id: 'aod-03',
        category: 'alias-on-departed-employee',
        why: 'An INFERRED strong signal on a departed employee still downgrades. The alias exception must not be over-generalised into the email and employee-number paths, whose reasoning — an old address pointing at a row the leaver process has finished with — is unchanged.',
        account: { accountKey: 'tokoro', displayName: 'Tomo Okoro', email: 'tomo.okoro@example.test' },
        hr: [departed('e-903', 'Tomo Okoro', '2026-07-15', {
            givenName: 'Tomo', familyName: 'Okoro', workEmail: 'tomo.okoro@example.test',
        })],
        directory: [],
        expected: { outcome: 'SUGGESTED', employeeId: 'e-903' },
    },
];
/**
 * One corpus case as engine input.
 *
 * Owned by the FIXTURE rather than written out at each consumer, because
 * `aliases: []` was hardcoded at every one of them — so an alias case was
 * unsatisfiable in three separate places, and fixing two of them still left a
 * LINKED case that could never link. Spread the result to add a `config`:
 *
 *     reconcile({ ...engineInputFor(c), config: step4aExtensions(c.hr) })
 *
 * A consumer that builds the object by hand reintroduces the defect, and the
 * next field added to `CorpusCase` will be dropped the same way.
 */
export function engineInputFor(c: CorpusCase): {
    accounts: readonly LegacyAccountSlice[];
    roster: readonly EmployeeSlice[];
    directory: readonly DirectoryAccountSlice[];
    aliases: readonly { readonly accountKey: string; readonly employeeId: string }[];
    now: string;
} {
    return {
        accounts: [c.account],
        roster: c.hr,
        directory: c.directory,
        aliases: c.aliases ?? [],
        now: CORPUS_NOW,
    };
}

/** The instant every corpus-driven run uses, so freshness is not per-consumer. */
export const CORPUS_NOW = '2026-10-08T00:00:00.000Z';

/** Every category the corpus claims to cover. Asserted exhaustive by its test. */
export const CORPUS_CATEGORIES: readonly CorpusCategory[] = [
    'last-first-order', 'initials', 'numeric-suffix', 'domain-alias',
    'cyrillic-streamlined', 'cyrillic-traditional', 'username-reuse-after-termination',
    'rekeyed-email', 'contractor', 'service-account', 'yot-and-yo', 'mixed-script',
    'pathological-input', 'alias-on-departed-employee',
];
