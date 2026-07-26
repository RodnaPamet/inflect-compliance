/**
 * Compliance-calendar label composition (client-side, i18n-aware).
 *
 * Event titles, category/status/source names used to be composed on the
 * SERVER as English strings (`"Evidence review: X"`, `"vendor-document"`),
 * so no locale could ever translate a calendar label. The server now returns
 * structured fields (`type`, `entityName`, `category`, `status`) and the
 * client composes the display strings from next-intl keys here.
 *
 * These are pure functions taking a `Translator` (a `useTranslations('calendar')`
 * instance) so both the page island and the shared view primitives
 * (CalendarMonth / CalendarHeatmap / GanttTimeline) compose identically.
 */

import type {
    CalendarEvent,
    CalendarEventCategory,
    CalendarEventStatus,
    CalendarSourceName,
} from '@/app-layer/schemas/calendar.schemas';

/** Minimal shape of a next-intl translator scoped to the `calendar` namespace. */
export interface CalendarTranslator {
    (key: string, values?: Record<string, string | number>): string;
    has?: (key: string) => boolean;
}

/**
 * The localized display title for an event: `"<type label>: <entity name>"`.
 * Falls back to the raw server `title` if `entityName` is absent (an event
 * from a cached pre-migration response) so nothing renders blank.
 */
export function composeEventTitle(
    t: CalendarTranslator,
    event: Pick<CalendarEvent, 'type' | 'entityName' | 'title'>,
): string {
    const typeLabel = t(`eventType.${event.type}`);
    if (event.entityName && event.entityName.length > 0) {
        return t('eventTitleFormat', { type: typeLabel, name: event.entityName });
    }
    // No structured name → fall back to the server-composed string.
    return event.title;
}

export function categoryLabel(
    t: CalendarTranslator,
    category: CalendarEventCategory,
): string {
    return t(`category.${category}`);
}

export function statusLabel(
    t: CalendarTranslator,
    status: CalendarEventStatus,
): string {
    return t(`status.${status}`);
}

export function sourceLabel(
    t: CalendarTranslator,
    source: CalendarSourceName,
): string {
    return t(`source.${source}`);
}
