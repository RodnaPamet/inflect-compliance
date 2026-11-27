/**
 * The content dictionaries and the lookup over them (#5996).
 */
import * as fs from 'fs';
import * as path from 'path';
import { BG_DICTIONARIES } from '@/data/content-i18n/bg';
import { localizeContentText, translateContentText, translateContentTexts } from '@/lib/content-i18n/dictionary';
import { catalogueStrings } from '../../../scripts/content-i18n/sources';
import { GENERIC_TEMPLATE_TASK_TITLES } from '../../../prisma/generic-template-tasks';

const DIR = path.join(__dirname, '..', '..', '..', 'src', 'data', 'content-i18n', 'bg');

describe('Bulgarian content dictionaries', () => {
    it('every JSON file in the folder is registered in the index', () => {
        const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort();
        // `generic-tasks` is built in code from the titles' single owner.
        expect(Object.keys(BG_DICTIONARIES).filter((k) => k !== 'generic-tasks').sort()).toEqual(files);
    });

    it('every entry translates a string the catalogues hold, into Cyrillic, keeping its placeholders', () => {
        const known = new Set([...catalogueStrings().values()].flat());
        const problems: string[] = [];
        for (const [name, dictionary] of Object.entries(BG_DICTIONARIES)) {
            for (const [source, target] of Object.entries(dictionary)) {
                if (!known.has(source.trim())) problems.push(`${name}: not a catalogue string: ${source.slice(0, 60)}`);
                if (!/[Ѐ-ӿ]/.test(target)) problems.push(`${name}: no Cyrillic in the translation of: ${source.slice(0, 60)}`);
                const marks = (s: string) => (s.match(/\{[A-Za-z_]+\}/g) ?? []).sort().join();
                if (marks(source) !== marks(target)) problems.push(`${name}: placeholders differ: ${source.slice(0, 60)}`);
            }
        }
        expect(problems).toEqual([]);
    });
});

describe('the lookup', () => {
    // A catalogue string the dictionary translates: the last generic task title.
    const source = GENERIC_TEMPLATE_TASK_TITLES[GENERIC_TEMPLATE_TASK_TITLES.length - 1];

    it('translates a catalogue string for a Bulgarian reader, whitespace around it ignored', () => {
        expect(translateContentText('bg', source)).toBe('Прегледайте ефективността');
        expect(translateContentText('bg', `  ${source}\n`)).toBe('Прегледайте ефективността');
    });

    it('asks nothing for an English reader', () => {
        expect(translateContentText('en', source)).toBeNull();
        expect(localizeContentText('en', source)).toBe(source);
    });

    it('leaves an edited text as written', () => {
        expect(translateContentText('bg', `${source} quarterly`)).toBeNull();
        expect(localizeContentText('bg', `${source} quarterly`)).toBe(`${source} quarterly`);
        expect(localizeContentText('bg', null)).toBeNull();
    });

    it('answers a batch with only the texts it translates', () => {
        expect(translateContentTexts('bg', [source, 'Something a person wrote'])).toEqual({
            [source]: 'Прегледайте ефективността',
        });
    });
});
