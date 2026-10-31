/**
 * Every calendar entry type and source has a label in every catalogue (#4628).
 *
 * `composeEventTitle` and `sourceLabel` look a type or source up under
 * `calendar.eventType` / `calendar.source`, and next-intl renders a missing key
 * as its path — so a loader that emits a new type with no label puts
 * `calendar.eventType.audit-scheduled: …` on the calendar. Two types and their
 * sources shipped that way. The lists here are the schema's own, so a new type
 * or source fails this test until it is labelled in both languages.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CALENDAR_EVENT_TYPES, CALENDAR_SOURCE_NAMES } from '@/app-layer/schemas/calendar.schemas';

type Catalogue = { calendar: { eventType: Record<string, unknown>; source: Record<string, unknown> } };
const read = (lang: string): Catalogue =>
    JSON.parse(readFileSync(join(__dirname, '..', '..', 'messages', `${lang}.json`), 'utf8')) as Catalogue;

describe.each(['en', 'bg'])('calendar labels — %s', (lang) => {
    const { calendar } = read(lang);

    it('labels every event type', () => {
        const missing = CALENDAR_EVENT_TYPES.filter((type) => typeof calendar.eventType[type] !== 'string');
        expect(missing).toEqual([]);
    });

    it('labels every source', () => {
        const missing = CALENDAR_SOURCE_NAMES.filter((source) => typeof calendar.source[source] !== 'string');
        expect(missing).toEqual([]);
    });
});
