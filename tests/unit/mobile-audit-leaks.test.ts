/**
 * The English-on-a-Bulgarian-page detector (`scripts/mobile-audit/leaks.ts`)
 * calls a leak a leak, and does not call seeded data, brands or acronyms one.
 * It backs the `englishLeaks` count in the mobile audit and the mobile E2E
 * ratchet, so a detector that drifted would move a baseline on its own.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
    buildLeakCatalog,
    buildWorkspaceTextMatcher,
    findEnglishLeaks,
    NO_WORKSPACE_TEXT,
    optionLabels,
    pageDataNames,
} from '../../scripts/mobile-audit/leaks';
import { getWorkflowDefinition } from '@/lib/agentic/workflow-registry';
import { localizedRunSummary, type WorkflowSummaryTranslator } from '@/lib/agentic/workflow-labels';
import type { WorkflowContext } from '@/lib/agentic/workflow-types';
import {
    NIS2_GROUP,
    STOCK_NOTIFICATIONS,
    localizedStockNotification,
    nis2QuestionCount,
    recordLabel,
    stockNotificationText,
    stockNotificationTitle,
} from '@/lib/notifications/stock-notifications';
const en = {
    nav: { back: 'Back to {section}', agents: 'Agents', controls: 'Controls' },
    filters: { clear: 'Clear filters', none: 'No results match these filters' },
    brand: { okta: 'Okta', iso: 'ISO 27001', ad: 'Active Directory' },
    login: { orgPlaceholder: 'Acme Corp' },
    untranslated: { principal: 'Service principal: {status} for the agent' },
    short: { user: 'User {name}' },
    plural: { items: '{count, plural, one {# item} other {# items}}' },
    run: { summary: 'Posture snapshot — {controls} controls, {risks} risks.' },
};
const bg = {
    nav: { back: 'Обратно към {section}', agents: 'Агенти', controls: 'Контроли' },
    filters: { clear: 'Изчисти филтрите', none: 'Няма резултати за тези филтри' },
    brand: { okta: 'Okta', iso: 'ISO 27001', ad: 'Active Directory (локален)' },
    login: { orgPlaceholder: 'Акме ООД' },
    untranslated: { principal: 'Service principal: {status} for the agent' },
    short: { user: 'Потребител {name}' },
    plural: { items: '{count, plural, one {# елемент} other {# елемента}}' },
    run: { summary: 'Моментна снимка — контроли: {controls}, рискове: {risks}.' },
};
const catalog = buildLeakCatalog(en, bg);
const leaksIn = (texts: string[], chromeTexts: string[] = [], names: string[] = []) =>
    findEnglishLeaks({ texts, chromeTexts }, catalog, new Set(names));

describe('findEnglishLeaks', () => {
    it('finds an English catalog message rendered on a Bulgarian page', () => {
        expect(leaksIn(['Clear filters'])).toEqual([{ text: 'Clear filters', reason: 'CATALOG' }]);
    });

    it('finds a placeholder message by its literal text', () => {
        expect(leaksIn(['Service principal: ACTIVE for the agent'])).toEqual([
            { text: 'Service principal: ACTIVE for the agent', reason: 'CATALOG' },
        ]);
    });

    it('finds an English label embedded in a Bulgarian sentence', () => {
        expect(leaksIn(['Обратно към Agents'])).toEqual([{ text: 'Обратно към Agents', reason: 'EMBEDDED' }]);
    });

    it('finds a whole templated English message behind a Bulgarian label, though no word of it is a message', () => {
        // A stored product sentence (a run summary) shown after a Bulgarian
        // label, in one text node. None of its Latin runs is a catalog
        // message on its own; the template is.
        const line = 'Обобщение: Posture snapshot — 3 controls, 7 risks.';
        expect(leaksIn([line])).toEqual([{ text: line, reason: 'EMBEDDED' }]);
        expect(leaksIn(['Обобщение: Моментна снимка — контроли: 3, рискове: 7.'])).toEqual([]);
    });

    it('finds an English month and a relative time', () => {
        expect(leaksIn(['29 November 2026', 'преди 20 minutes ago']).map((l) => l.reason)).toEqual(['DATE', 'DATE']);
    });

    it('finds a short hard-coded English control label that never reached the catalog', () => {
        expect(leaksIn(['Expand all'], ['Expand all'])).toEqual([{ text: 'Expand all', reason: 'CHROME' }]);
    });

    it('does not call Bulgarian text, a kept brand or an acronym a leak', () => {
        expect(leaksIn(['Изчисти филтрите', 'Okta', 'ISO 27001', 'Обратно към Контроли'], ['Okta'])).toEqual([]);
    });

    it('does not call a product name the Bulgarian catalog keeps a leak', () => {
        expect(leaksIn(['Active Directory (локален)', 'Свързва се с Active Directory през LDAPS'])).toEqual([]);
    });

    it('does not call a seeded name a leak, alone or inside a sentence', () => {
        expect(leaksIn(['Acme Corp', 'Acme Corp: 4 риска'], [], ['Acme Corp'])).toEqual([]);
    });

    it('does not judge a seeded title by the word heuristic, even on a button', () => {
        expect(leaksIn(['Implement MFA for privileged accounts'], ['Implement MFA for privileged accounts'])).toEqual([]);
    });

    it('does not match data against a placeholder message with a short literal', () => {
        // "User {name}" would otherwise match the seeded control "User Endpoint Devices".
        expect(leaksIn(['User Endpoint Devices'])).toEqual([]);
    });

    describe('library content (owner decision 2026-11-23: content, not interface text)', () => {
        const libCatalog = buildLeakCatalog(
            {
                severity: { high: 'High' },
                category: { rm: 'Risk Management' },
                nav: { back: 'Back to {section}', risks: 'Risks' },
                filters: { clear: 'Clear filters' },
            },
            {
                severity: { high: 'Висок' },
                category: { rm: 'Управление на риска' },
                nav: { back: 'Обратно към {section}', risks: 'Рискове' },
                filters: { clear: 'Изчисти филтрите' },
            },
        );
        const library = new Set([
            'Logging and Monitoring', // a control template title: the word heuristic would call it chrome
            'Risk Management', // a template category the catalog also holds
            'The operating rules for drones, as amended up to 29 November 2026', // a framework description with a date
            'High', // a questionnaire option that is also the severity label
        ]);
        const leaksWithLibrary = (texts: string[], chromeTexts: string[] = []) =>
            findEnglishLeaks({ texts, chromeTexts }, libCatalog, new Set(), library);

        it('does not call a library title, a multi-word category or a library description a leak', () => {
            expect(
                leaksWithLibrary(
                    ['Logging and Monitoring', 'Risk Management', 'The operating rules for drones, as amended up to 29 November 2026'],
                    ['Logging and Monitoring', 'Risk Management'],
                ),
            ).toEqual([]);
        });

        it('still judges the same strings when no library row holds them', () => {
            const without = findEnglishLeaks(
                { texts: ['Logging and Monitoring', 'Risk Management'], chromeTexts: ['Logging and Monitoring'] },
                libCatalog,
            );
            expect(without.map((l) => l.reason).sort()).toEqual(['CATALOG', 'CHROME']);
        });

        it('still judges interface strings on a page full of library content', () => {
            expect(leaksWithLibrary(['Logging and Monitoring', 'Clear filters', 'Обратно към Risks'])).toEqual([
                { text: 'Clear filters', reason: 'CATALOG' },
                { text: 'Обратно към Risks', reason: 'EMBEDDED' },
            ]);
        });

        it('still judges a one-word library value that is also a catalog label, as the interface string', () => {
            expect(leaksWithLibrary(['High'])).toEqual([{ text: 'High', reason: 'CATALOG' }]);
        });

        it('does not call a multi-word library phrase inside a Bulgarian sentence a leak', () => {
            expect(leaksWithLibrary(['Категория: Risk Management'])).toEqual([]);
        });

        it('does not call a word of a library title a leak when the sentence carries the whole title', () => {
            // "Избор на {name}" with a control template's title in it: "Monitoring"
            // is also an English catalog label, but here it is the title's word.
            const monCatalog = buildLeakCatalog({ nav: { monitoring: 'Monitoring' } }, { nav: { monitoring: 'Наблюдение' } });
            const title = 'Monitoring, review and change management of supplier services';
            const find = (texts: string[]) => findEnglishLeaks({ texts, chromeTexts: texts }, monCatalog, new Set(), new Set([title]));
            expect(find([`Избор на A-5.22 ${title}`])).toEqual([]);
            // The same word without the title around it is the interface's word.
            expect(find(['Избор на Monitoring'])).toEqual([{ text: 'Избор на Monitoring', reason: 'EMBEDDED' }]);
            // And a sentence carrying only part of the title is not vouched for by it.
            expect(find(['Избор на Monitoring, review'])).toEqual([{ text: 'Избор на Monitoring, review', reason: 'EMBEDDED' }]);
        });
    });

    describe('a product name in Bulgarian prose (#5924)', () => {
        // "Signal" is also a catalog label (a column, "Сигнал"); here it names an app.
        const appCatalog = buildLeakCatalog(
            { nav: { back: 'Back to {section}' }, queue: { signal: 'Signal' }, kinds: { risk: 'Risk' } },
            { nav: { back: 'Обратно към {section}' }, queue: { signal: 'Сигнал' }, kinds: { risk: 'Риск' } },
        );
        const find = (texts: string[]) => findEnglishLeaks({ texts, chromeTexts: [] }, appCatalog);

        it('does not call an app named as an example, in an aside of a Bulgarian sentence, a leak', () => {
            expect(
                find([
                    'Криптирана ли е фирмената ви поща? Използвате ли сигурни съобщения (Teams, Signal) вместо некриптирани SMS за чувствителни теми?',
                    'Ако пощата ви спре по време на кибератака, как ще комуникира екипът? Има ли резервен план (телефонно дърво, група в Signal, списък с лични имейли)?',
                ]),
            ).toEqual([]);
        });

        it('still finds the same word interpolated where a Bulgarian word should stand', () => {
            // A label in a short string, and a label in a sentence but outside an aside.
            const outside = 'Сигурни ли сте, че искате да изтриете този Risk завинаги от системата?';
            expect(find(['Обратно към Signal', outside])).toEqual([
                { text: 'Обратно към Signal', reason: 'EMBEDDED' },
                { text: outside, reason: 'EMBEDDED' },
            ]);
        });

        it('still finds a label in an aside of a string too short to be a sentence', () => {
            expect(find(['Колона (Signal)'])).toEqual([{ text: 'Колона (Signal)', reason: 'EMBEDDED' }]);
        });
    });

    it('skips ICU plurals, whose literal text is not one string', () => {
        expect(catalog.patterns.some((p) => p.literal.includes('item'))).toBe(false);
    });
});

describe('optionLabels (the seeded questionnaires\' option text, for the library set)', () => {
    it('reads object options, plain-string options and a scale\'s labels, and nothing else', () => {
        expect(optionLabels([{ label: 'Yes', value: 'yes', points: 1 }, { label: 'No', value: 'no' }])).toEqual(['Yes', 'No']);
        expect(optionLabels(['Manual', 'Automated'])).toEqual(['Manual', 'Automated']);
        expect(optionLabels({ min: 1, max: 5, labels: ['Poor', 'Excellent'] })).toEqual(['Poor', 'Excellent']);
        expect(optionLabels(null)).toEqual([]);
        expect(optionLabels({ value: 'x' })).toEqual([]);
        expect(optionLabels([{ value: 'no-label' }, 3])).toEqual([]);
    });
});

describe('pageDataNames: a questionnaire\'s answer options are data beside their question (#5924)', () => {
    // A tenant's own vendor questionnaire offers "Yes", "Partial", "Other":
    // each is also a one-word catalog label, and none is the interface's.
    const optCatalog = buildLeakCatalog(
        { common: { yes: 'Yes', other: 'Other' }, status: { partial: 'Partial' } },
        { common: { yes: 'Да', other: 'Друго' }, status: { partial: 'Частично' } },
    );
    const questions = new Map([['Do you encrypt data at rest?', ['Yes', 'Partial', 'Other']]]);
    const leaksOn = (texts: string[]) =>
        findEnglishLeaks({ texts, chromeTexts: texts }, optCatalog, pageDataNames(texts, new Set(['Acme Corp']), questions));

    it('does not call an option a leak on a page that shows its question', () => {
        expect(leaksOn(['Do you encrypt data at rest?', 'Yes', 'Partial', 'Other'])).toEqual([]);
    });

    it('still judges the same words on a page that does not show the question', () => {
        expect(leaksOn(['Yes', 'Partial']).map((l) => l.text)).toEqual(['Yes', 'Partial']);
    });

    it('keeps the page\'s other data names, and adds nothing when no question is shown', () => {
        const names = new Set(['Acme Corp']);
        expect(pageDataNames(['Нещо друго'], names, questions)).toBe(names);
        expect([...pageDataNames(['Do you encrypt data at rest?'], names, questions)].sort()).toEqual(['Acme Corp', 'Other', 'Partial', 'Yes']);
    });
});

describe('the catalog built from the repository', () => {
    const root = path.resolve(__dirname, '..', '..');
    const real = buildLeakCatalog(
        JSON.parse(readFileSync(path.join(root, 'messages', 'en.json'), 'utf8')),
        JSON.parse(readFileSync(path.join(root, 'messages', 'bg.json'), 'utf8')),
    );

    it('is non-empty, so a parse change cannot silently zero every leak count', () => {
        expect(real.exact.size).toBeGreaterThan(1000);
        expect(real.patterns.length).toBeGreaterThan(100);
    });

    it('holds no Bulgarian text', () => {
        expect(Array.from(real.exact).filter((s) => /[Ѐ-ӿ]/.test(s))).toEqual([]);
    });
});

describe('a sentence the product stores in English and shows as stored (#5883)', () => {
    // The class #5883 found on `agents/runs` in Bulgarian: the diagnostic
    // workflow's run summary, written by the product in English, kept as the
    // run's record, and shown as stored. The detector missed it while its
    // template was in no catalog. These run against the REAL catalog and the
    // summary the workflow's own synthesis step writes, so a detector change,
    // a catalog change or a builder change that loses it fails here.
    const root = path.resolve(__dirname, '..', '..');
    const enJson = JSON.parse(readFileSync(path.join(root, 'messages', 'en.json'), 'utf8'));
    const bgJson = JSON.parse(readFileSync(path.join(root, 'messages', 'bg.json'), 'utf8'));
    const real = buildLeakCatalog(enJson, bgJson);
    const onPage = (texts: string[]) => findEnglishLeaks({ texts, chromeTexts: [] }, real);

    function storedDiagnosticSummary(stats: { controls: number; risks: number; openTasks: number }): string {
        const step = getWorkflowDefinition('diagnostic')?.steps.find((s) => s.kind === 'SYNTHESIS');
        if (!step || step.kind !== 'SYNTHESIS') throw new Error('the diagnostic workflow has no synthesis step');
        return step.synthesize({ outputs: { posture: { stats } } } as unknown as WorkflowContext).text;
    }
    const stored = storedDiagnosticSummary({ controls: 42, risks: 17, openTasks: 9 });
    const bgTranslator: WorkflowSummaryTranslator = (key, values) => {
        const [workflow, field] = key.split('.');
        const template = bgJson.agentWorkflows[workflow][field] as string;
        return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in values ? String(values[name]) : m));
    };

    it('is a leak when the runs page shows it as stored', () => {
        expect(stored.startsWith('Posture snapshot')).toBe(true);
        expect(onPage([stored])).toEqual([{ text: stored, reason: 'CATALOG' }]);
    });

    it('is a leak behind a Bulgarian label, in one text node', () => {
        const line = `Обобщение: ${stored}`;
        expect(onPage([line])).toEqual([{ text: line, reason: 'EMBEDDED' }]);
    });

    it("is not a leak once the page re-words it, nor is an agent's own English summary", () => {
        const shown = localizedRunSummary('diagnostic', stored, bgTranslator);
        expect(shown).not.toBe(stored);
        expect(onPage([shown as string])).toEqual([]);
        // An agent's words are data: free prose in no catalog is never judged.
        expect(onPage(['Reviewed the posture and found three controls without evidence.'])).toEqual([]);
    });
});

describe('a stock notification stored in English and shown as stored (#5929)', () => {
    // The assignment, task-due, watched-task and NIS2 notifications are
    // written once, in English, and re-worded on read. While their sentences
    // were in no catalog the detector could not tell them from tenant data.
    // These run against the REAL catalog and the text the emitters' own
    // templates produce, so losing the en messages, or a template drifting
    // from them, fails here.
    const root = path.resolve(__dirname, '..', '..');
    const enJson = JSON.parse(readFileSync(path.join(root, 'messages', 'en.json'), 'utf8'));
    const bgJson = JSON.parse(readFileSync(path.join(root, 'messages', 'bg.json'), 'utf8'));
    const real = buildLeakCatalog(enJson, bgJson);
    const onPage = (texts: string[]) => findEnglishLeaks({ texts, chromeTexts: [] }, real);
    const at = (ns: unknown, key: string) =>
        key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], ns) as string;
    const bgBodies = (key: string, values: Record<string, string | number> = {}) =>
        at(bgJson.notificationBodies, key).replace(/\{(\w+)\}/g, (whole, name: string) =>
            name in values ? String(values[name]) : whole,
        );
    const bgTitles = (key: string, values: Record<string, string | number> = {}) =>
        at(bgJson.notificationTitles, key).replace(/\{(\w+)\}/g, (whole, name: string) =>
            name in values ? String(values[name]) : whole,
        );

    const label = recordLabel('Rotate keys', 'T-12');
    const stored = [
        {
            type: 'TASK_ASSIGNED',
            title: STOCK_NOTIFICATIONS.TASK_ASSIGNED.title,
            message: stockNotificationText('TASK_ASSIGNED', { label }),
        },
        {
            type: 'TASK_DUE',
            title: STOCK_NOTIFICATIONS.TASK_DUE_DAY.title,
            message: stockNotificationText('TASK_DUE_DAY', { label }),
        },
        {
            type: 'GENERAL',
            title: STOCK_NOTIFICATIONS.NIS2_GAP_ASSIGNED.title,
            message: stockNotificationText('NIS2_GAP_ASSIGNED', { count: nis2QuestionCount(12), group: NIS2_GROUP.IT }),
        },
        {
            // A title with a record in it: caught by its template, not as one string.
            type: 'VENDOR_REVIEW_DUE',
            title: stockNotificationTitle('VENDOR_REVIEW_PAST_DUE', { name: 'Northwind Cloud' }),
            message: stockNotificationText('VENDOR_REVIEW_PAST_DUE', { name: 'Northwind Cloud' }),
        },
    ];

    it.each(stored)('$type: the title and the body are leaks when shown as stored', ({ title, message }) => {
        expect(onPage([title, message])).toEqual([
            { text: title, reason: 'CATALOG' },
            { text: message, reason: 'CATALOG' },
        ]);
    });

    it.each(stored)('$type: neither is a leak once the page re-words it', ({ type, title, message }) => {
        const worded = localizedStockNotification({ type, title, message }, bgTitles, bgBodies);
        expect(worded).toBeDefined();
        const shown = [worded!.title, worded!.message];
        expect(shown).not.toContain(title);
        expect(shown).not.toContain(message);
        expect(onPage(shown)).toEqual([]);
    });
});

/**
 * A RECORD THE SERVER WROTE IN THE WORKSPACE'S OWN LANGUAGE — #5972.
 *
 * `workspaceText.*` is written into a record once, in the workspace's default
 * language, and never re-worded on read (owner decision 2026-11-24, #5868). So
 * the English NIS2 task title below, on a Bulgarian page, is the record's
 * correct text in an English-DEFAULT workspace — and a leak in a Bulgarian one.
 *
 * The real catalog and the two real strings the nightly audit reported on
 * 2026-11-25 are used on purpose: this fails if either the message or the
 * detector moves.
 */
describe('a record written in the workspace language', () => {
    const root = path.resolve(__dirname, '..', '..');
    const enJson = JSON.parse(readFileSync(path.join(root, 'messages', 'en.json'), 'utf8'));
    const bgJson = JSON.parse(readFileSync(path.join(root, 'messages', 'bg.json'), 'utf8'));
    const realCatalog = buildLeakCatalog(enJson, bgJson);
    const TITLE = 'Answer the NIS2 gap assessment questions for IT (72 questions)';
    const SENTENCE = `TSK-4 "${TITLE}" вече е ваша отговорност.`;
    const find = (workspace: Parameters<typeof findEnglishLeaks>[4]) =>
        findEnglishLeaks({ texts: [TITLE, SENTENCE], chromeTexts: [] }, realCatalog, new Set(), new Set(), workspace);

    it('is not a leak when the workspace default language is the one it is written in', () => {
        expect(find(buildWorkspaceTextMatcher(enJson))).toEqual([]);
    });

    it('IS a leak when the workspace default language is the other one', () => {
        // The case the check exists for: the record really was written in the
        // wrong language, so the title and the sentence quoting it both count.
        expect(find(buildWorkspaceTextMatcher(bgJson)).map((l) => l.reason).sort()).toEqual(['CATALOG', 'EMBEDDED']);
    });

    it('is a leak with no matcher at all, which is the regression this rule fixes', () => {
        // Six routes a night from 2026-11-25, caused by #5932 adding the title
        // to the catalog. Removing the matcher reproduces it exactly.
        expect(find(NO_WORKSPACE_TEXT).map((l) => l.reason).sort()).toEqual(['CATALOG', 'EMBEDDED']);
    });

    describe('what it refuses to exclude', () => {
        const synthEn = {
            workspaceText: { t: { title: 'Answer the questions for {group} today' } },
            filters: { clear: 'Clear filters' },
        };
        const synthBg = {
            workspaceText: { t: { title: 'Отговорете на въпросите за {group} днес' } },
            filters: { clear: 'Изчисти филтрите' },
        };
        const synthCatalog = buildLeakCatalog(synthEn, synthBg);

        it('still reports a leak in the sentence AROUND the record', () => {
            // The record's own text is removed and what is LEFT is judged, so a
            // sentence carrying both a record and a real leak is not excused by
            // the record.
            const text = 'Задача „Answer the questions for IT today“ — Clear filters';
            expect(
                findEnglishLeaks({ texts: [text], chromeTexts: [] }, synthCatalog, new Set(), new Set(), buildWorkspaceTextMatcher(synthEn)),
            ).toEqual([{ text, reason: 'EMBEDDED' }]);
        });

        it('builds no pattern for a template whose literal text identifies nothing', () => {
            // `"{type}: {name}"` would match any "X: Y" the page shows.
            expect(buildWorkspaceTextMatcher({ workspaceText: { c: { title: '{type}: {name}' } } }).patterns).toEqual([]);
        });

        it('leaves a value that is ALSO a message under another key judged', () => {
            // "Evidence review" is a calendar event type here and may be an
            // interface label there; only the key tells them apart.
            const m = buildWorkspaceTextMatcher({
                workspaceText: { calendarPush: { eventType: { 'evidence-review': 'Evidence review' } } },
                calendar: { heading: 'Evidence review' },
            });
            expect([...m.exact]).toEqual([]);
        });

        it('excludes a SHORT record value that is also a control label', () => {
            // The exclusion sits beside the other data tests rather than in the
            // CATALOG branch alone. Gated only at CATALOG, a short value would
            // fall through and be reported as CHROME instead — the exclusion
            // bypassed under a different reason. Asserted both ways, so the
            // second expectation proves the string really would be reported.
            const en2 = { workspaceText: { t: { label: 'View your tasks now' } } };
            const bg2 = { workspaceText: { t: { label: 'Вижте задачите си сега' } } };
            const c2 = buildLeakCatalog(en2, bg2);
            const page = { texts: ['View your tasks now'], chromeTexts: ['View your tasks now'] };
            expect(findEnglishLeaks(page, c2, new Set(), new Set(), buildWorkspaceTextMatcher(en2))).toEqual([]);
            expect(findEnglishLeaks(page, c2, new Set(), new Set(), NO_WORKSPACE_TEXT)).toHaveLength(1);
        });

        it('reads nothing outside the workspaceText namespace', () => {
            const m = buildWorkspaceTextMatcher({ filters: { none: 'No results match these filters' } });
            expect([...m.exact]).toEqual([]);
            expect(m.patterns).toEqual([]);
        });
    });
});
