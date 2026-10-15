/**
 * A HELD-OUT set for the DETERMINISTIC engine. Never part of `CORPUS`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE GAP THIS FILLS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `identity-reconcile-precision.test.ts` gates the engine's precision — no
 * `LINKED` the corpus does not expect — and floors its recall, and it reads
 * `CORPUS` for both. So until now the only set the engine was measured on was
 * the only set that existed.
 *
 * That is not "fitted" in the statistical sense: the engine's rules are
 * hand-written from a design document, not searched for against this data. But
 * it is unvalidated on unseen data, and the difference matters for the same
 * reason the adjudication path has a held-out half (see
 * `adjudication/held-out.ts`): a claim measured only where it was authored
 * cannot distinguish "the rules are right" from "the rules and the fixtures
 * were written by the same hand on the same afternoon".
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW `expected` WAS DECIDED, WHICH IS THE WHOLE POINT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * From the question a reviewer would answer — *who is this person, and is the
 * evidence strong enough that nobody need confirm it?* — and NOT from running
 * the engine and recording its output. Expectations taken from the engine would
 * make this file a transcript, green by construction, exactly the circularity
 * that removed the committed evaluation record (#3462: thresholds chosen on the
 * 19 cases their own `precision = 1.0` was measured over).
 *
 * So a disagreement between this file and the engine is a FINDING, in one
 * direction or the other, and must be adjudicated rather than edited away. Where
 * the engine disagreed and the engine was right, the case says so in its `why`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT CANNOT BE EXERCISED HERE, AND WHY THAT IS NOT A GAP
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `engineInputFor` supplies accounts, roster, directory, aliases and `now` — no
 * declared username convention. That is faithful rather than limiting: a
 * convention is adopted by a human per connection
 * (`adoptUsernameConvention`, `assertCanAdmin`, versioned and audited), and
 * inferring one for a fixture is the circular fit `conventions.ts` forbids in
 * its own module header. So `CONVENTION` never fires below, and the four strong
 * kinds that can produce `LINKED` are `CONFIRMED_ALIAS`, `EMPLOYEE_NUMBER`,
 * `EMAIL_EXACT` and `DIRECTORY_BRIDGE`.
 *
 * Every case is a situation the corpus does not contain. Ids are `ho2-` to keep
 * them distinguishable from `adjudication/held-out.ts`'s `ho-`.
 *
 * @module tests/fixtures/identity-reconcile/held-out
 */
import type {
    CorpusCase,
    DirectoryAccountSlice,
    EmployeeSlice,
} from './corpus';

const active = (id: string, fullName: string, extra: Partial<EmployeeSlice> = {}): EmployeeSlice => ({
    id, fullName, status: 'ACTIVE', startDate: '2019-03-04', ...extra,
});

const departed = (
    id: string,
    fullName: string,
    endDate: string,
    extra: Partial<EmployeeSlice> = {},
): EmployeeSlice => ({
    id, fullName, status: 'TERMINATED', startDate: '2018-02-05', endDate, ...extra,
});

/**
 * A directory row that the BRIDGE can actually key on.
 *
 * `buildBridgeIndex` indexes `samAccountName` and the UPN's local part — NOT
 * the `email` field. My first draft of this file set only `email`, and every
 * bridge case came back `UNMATCHED (NO_CANDIDATES)`: the index had nothing to
 * look the account up by. Worth leaving as a note rather than a silent fix,
 * because "the bridge joins on an address" is the intuitive reading and it is
 * wrong — it joins on a LOGIN, which is what the JML chain also joins on.
 */
const bridge = (
    samAccountName: string,
    linkedEmployeeId: string | null,
    linkFresh: boolean,
): DirectoryAccountSlice => ({
    connectionId: 'c-ho2',
    email: `${samAccountName}@example.test`,
    samAccountName,
    linkedEmployeeId,
    linkFresh,
});

export const HELD_OUT: readonly CorpusCase[] = [
    // ── The four strong kinds, each on its own ────────────────────────────
    {
        id: 'ho2-em-01',
        category: 'domain-alias',
        why: 'EMAIL_EXACT on byte-equal emailKey, and nothing else. The one kind that links on an address.',
        account: { accountKey: 'rilieva', displayName: 'Ilieva, Radka', email: 'radka.ilieva@example.test' },
        hr: [
            active('e-701', 'Radka Ilieva', {
                givenName: 'Radka', familyName: 'Ilieva', workEmail: 'radka.ilieva@example.test',
            }),
            active('e-799', 'Pavel Enev', { givenName: 'Pavel', familyName: 'Enev' }),
        ],
        directory: [],
        expected: { outcome: 'LINKED', employeeId: 'e-701' },
    },
    {
        id: 'ho2-en-01',
        category: 'numeric-suffix',
        why: 'An ALL-DIGIT login that is genuinely a payroll number. The strong reading is the right one here.',
        account: { accountKey: '100482', displayName: null },
        hr: [
            active('e-702', 'Stoyan Grozev', {
                givenName: 'Stoyan', familyName: 'Grozev', employeeNumber: '100482',
            }),
            active('e-798', 'Mira Hristova', { givenName: 'Mira', familyName: 'Hristova', employeeNumber: '100483' }),
        ],
        directory: [],
        expected: { outcome: 'LINKED', employeeId: 'e-702' },
    },
    {
        id: 'ho2-db-01',
        category: 'rekeyed-email',
        why: 'A FRESH directory bridge carries the link even though the names share nothing — this is the signal the JML chain already joins on.',
        account: { accountKey: 'tz01', displayName: 'T. Zh.', email: 'tz01@example.test' },
        hr: [active('e-703', 'Teodora Zhekova', { givenName: 'Teodora', familyName: 'Zhekova' })],
        directory: [bridge('tz01', 'e-703', true)],
        expected: { outcome: 'LINKED', employeeId: 'e-703' },
    },
    {
        id: 'ho2-al-01',
        category: 'alias-on-departed-employee',
        why: 'A confirmed alias on a TERMINATED employee whose account predates the end date. A departure never suspends an alias — without it this leaver with live access becomes an UNMATCHED row nobody triages.',
        account: { accountKey: 'legacy_vk', displayName: 'V. Kirilov', createdAt: '2021-05-04T09:00:00.000Z' },
        hr: [departed('e-704', 'Ventsislav Kirilov', '2026-02-27', { givenName: 'Ventsislav', familyName: 'Kirilov' })],
        directory: [],
        aliases: [{ accountKey: 'legacy_vk', employeeId: 'e-704' }],
        expected: { outcome: 'LINKED', employeeId: 'e-704' },
    },

    // ── Where a strong kind must REFUSE to fire ──────────────────────────
    {
        id: 'ho2-en-02',
        category: 'numeric-suffix',
        why: 'THE DOCUMENTED TRAP, on unseen data: `normaliseEmployeeNumber` accepts up to eight leading letters, so `kpatel3` yields `3` — a name with a counter posing as the strongest signal in the system. It must not link to the employee who really is number 3.',
        account: { accountKey: 'kpatel3', displayName: 'Kamen Patel' },
        hr: [
            active('e-705', 'Nadia Ruseva', { givenName: 'Nadia', familyName: 'Ruseva', employeeNumber: '3' }),
            active('e-706', 'Kamen Patel', { givenName: 'Kamen', familyName: 'Patel' }),
        ],
        directory: [],
        expected: { outcome: 'SUGGESTED', employeeId: 'e-706' },
    },
    {
        id: 'ho2-em-02',
        category: 'domain-alias',
        why: 'Same local part, different domain. EMAIL_EXACT is emailKey BYTE-equality and must not fold the domain — a link made on a folded address is one the leaver pass cannot act on.',
        account: { accountKey: 'ikolev', displayName: 'Ivan Kolev', email: 'ivan.kolev@old-corp.example' },
        hr: [active('e-707', 'Ivan Kolev', {
            givenName: 'Ivan', familyName: 'Kolev', workEmail: 'ivan.kolev@example.test',
        })],
        directory: [],
        expected: { outcome: 'SUGGESTED', employeeId: 'e-707' },
    },
    {
        id: 'ho2-db-02',
        category: 'rekeyed-email',
        why: 'A directory row whose link is NOT fresh. The bridge requires fresh AND uncontradicted, so a stale link may support but never link.',
        account: { accountKey: 'ggeorgiev', displayName: 'Georgi Georgiev', email: 'ggeorgiev@example.test' },
        hr: [active('e-708', 'Georgi Georgiev', { givenName: 'Georgi', familyName: 'Georgiev' })],
        directory: [bridge('ggeorgiev', 'e-708', false)],
        expected: { outcome: 'SUGGESTED', employeeId: 'e-708' },
    },

    // ── Ambiguity: an equal score must not be broken ─────────────────────
    {
        id: 'ho2-am-01',
        category: 'last-first-order',
        why: 'Two roster members a username fits equally. The tie rule must not prefer the earlier hire or the lower id — and UNMATCHED is the refusal. RESOLVED (#3550, owner decision 2026-10-15): this case and `ho2-in-01` were written expecting AMBIGUOUS and the engine returned UNMATCHED; both candidates come from the family-name blocker and both score 0 with no signals, so there is nothing to be ambiguous ABOUT. The held-out set reproducing the corpus `in-01` disagreement on unseen data is what made it a decision rather than a fixture slip. The invariant is now gated in `identity-reconcile-precision`, so this expectation cannot drift back silently.',
        account: { accountKey: 'apetrov', displayName: 'A. Petrov' },
        hr: [
            active('e-709', 'Angel Petrov', { givenName: 'Angel', familyName: 'Petrov' }),
            active('e-710', 'Anton Petrov', { givenName: 'Anton', familyName: 'Petrov' }),
        ],
        directory: [],
        expected: { outcome: 'UNMATCHED', employeeId: null },
    },
    {
        id: 'ho2-in-01',
        category: 'initials',
        why: 'Two initials and a surname, with two roster members matching both initials. More evidence than ho2-am-01 and still not enough to choose. Note "more evidence" is about what a PERSON can see: the engine holds two candidates at score 0 with no signals here too, which is why it answers UNMATCHED and why #3550 settled on that (owner decision 2026-10-15). Two independent cases, same answer, neither of them the one the corpus already carried.',
        account: { accountKey: 'a.b.kostov', displayName: 'A. B. Kostov' },
        hr: [
            active('e-711', 'Atanas Kostov', { givenName: 'Atanas', familyName: 'Kostov' }),
            active('e-712', 'Angel Kostov', { givenName: 'Angel', familyName: 'Kostov' }),
        ],
        directory: [],
        expected: { outcome: 'UNMATCHED', employeeId: null },
    },

    // ── Transliteration: supporting only, never strong ───────────────────
    {
        id: 'ho2-cy-01',
        category: 'cyrillic-streamlined',
        why: 'Щ under the streamlined 2009 scheme is `sht`. A correct romanisation is still a SUPPORTING signal — a person confirms the link.',
        account: { accountKey: 'gshterev', displayName: 'Георги Щерев' },
        hr: [active('e-713', 'Georgi Shterev', { givenName: 'Georgi', familyName: 'Shterev' })],
        directory: [],
        expected: { outcome: 'SUGGESTED', employeeId: 'e-713' },
        normalForms: { translitContains: ['Shterev'] },
    },
    {
        id: 'ho2-cy-02',
        category: 'yot-and-yo',
        why: 'A Russian ё and a leading й in one name. Both pass through rather than silently becoming e and i — which means NO match, not a fuzzy one. I EXPECTED SUGGESTED HERE AND WAS WRONG: the engine returns UNMATCHED (candidate generated, score 0, no NAME_TRANSLIT signal) and the corpus already says the same thing at `yo-03`, whose shape is identical. Not folding ё is the deliberate rule, and the price of the rule is this row. Kept because the price is worth stating.',
        account: { accountKey: 'fyovkov', displayName: 'Фёдор Йовков' },
        hr: [active('e-714', 'Fyodor Yovkov', { givenName: 'Fyodor', familyName: 'Yovkov' })],
        directory: [],
        expected: { outcome: 'UNMATCHED', employeeId: null },
        normalForms: { nameFamily: 'Йовков' },
    },

    // ── Nothing to match, and nothing invented ───────────────────────────
    {
        id: 'ho2-co-01',
        category: 'contractor',
        why: 'A vendor account with no HR record at all, offered a roster of unrelated people. UNMATCHED is the correct answer and a candidate here would invite a reviewer to link a contractor to a stranger.',
        account: { accountKey: 'jjovanovic', displayName: 'Jovan Jovanović (vendor)', email: 'jovan@vendor.example.invalid' },
        hr: [
            active('e-715', 'Elena Marinova', { givenName: 'Elena', familyName: 'Marinova' }),
            active('e-716', 'Boris Tanev', { givenName: 'Boris', familyName: 'Tanev' }),
        ],
        directory: [],
        expected: { outcome: 'UNMATCHED', employeeId: null },
    },
    {
        id: 'ho2-sa-01',
        category: 'service-account',
        why: 'A service prefix is decided BEFORE matching, so it can never bury a real leaver in the orphan list.',
        account: { accountKey: 'svc_nightly_sync', displayName: null, email: null },
        hr: [active('e-717', 'Sylvia Nikolova', { givenName: 'Sylvia', familyName: 'Nikolova' })],
        directory: [],
        expected: { outcome: 'NON_PERSON', employeeId: null },
    },

    {
        id: 'ho2-ms-01',
        category: 'mixed-script',
        why: 'A Cyrillic а inside an otherwise Latin surname — a look-alike typed through the wrong keyboard layout. Folding it recovers the intent, and a purely Cyrillic token must never be folded the same way.',
        account: { accountKey: 'nikolov', displayName: `Nikol\u0430v, Nikola` },
        hr: [active('e-719', 'Nikola Nikolov', { givenName: 'Nikola', familyName: 'Nikolov' })],
        directory: [],
        expected: { outcome: 'SUGGESTED', employeeId: 'e-719' },
    },

    // ── Temporal: an account that postdates the employment it claims ─────
    {
        id: 'ho2-ur-01',
        category: 'username-reuse-after-termination',
        why: 'The login of a departed employee, recreated AFTER their end date — so it belongs to somebody else now. Linking it to the leaver would report a live account as theirs and hide whoever actually holds it.',
        account: { accountKey: 'ddimitrov', displayName: 'D. Dimitrov', createdAt: '2026-06-01T08:00:00.000Z' },
        hr: [departed('e-718', 'Dancho Dimitrov', '2026-03-31', { givenName: 'Dancho', familyName: 'Dimitrov' })],
        directory: [],
        expected: { outcome: 'UNMATCHED', employeeId: null },
    },
];

/** Stated so a shrinking set is visible rather than silent. */
export const HELD_OUT_SIZE = HELD_OUT.length;
