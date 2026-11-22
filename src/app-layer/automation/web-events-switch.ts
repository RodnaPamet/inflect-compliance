/**
 * `AUTOMATION_WEB_EVENTS_ENABLED` — whether an automation event emitted in the
 * WEB process is dispatched (owner decision, 2026-11-13).
 *
 * Until the automation bus moved to `globalThis` (see `automation-bus.ts`),
 * no event a web request emitted ever reached the queue, so no rule fired from
 * a task, risk or control created through the UI or the API. Fixing that wakes
 * every ENABLED rule for new web events at once, so it ships OFF: unset, or any
 * value but `1` / `true`, keeps today's behaviour. Turning it on replays
 * nothing that was dropped before; it applies to events emitted afterwards.
 *
 * Read only by the WEB tier's dispatcher (`installAutomationBusDispatcher('web')`).
 * The worker's dispatcher never reads it: worker-tier events, which fired all
 * along, fire whatever it says.
 */
import { env } from '@/env';

export const AUTOMATION_WEB_EVENTS_SWITCH = 'AUTOMATION_WEB_EVENTS_ENABLED';

export function automationWebEventsEnabled(): boolean {
    const value = env.AUTOMATION_WEB_EVENTS_ENABLED?.trim().toLowerCase();
    return value === '1' || value === 'true';
}
