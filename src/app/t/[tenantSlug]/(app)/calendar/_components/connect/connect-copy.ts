/**
 * The Connect control's vocabulary (#5937 step 4): the server's closed sets,
 * mapped to the `calendarConnect` message keys that word them.
 *
 * Every map is a `Record` over a type imported from the server module that
 * owns the set (type-only imports: nothing server-side is bundled), so a value
 * the server adds — a new callback outcome, a new refusal, a new connection
 * state — fails `tsc` here until somebody words it. The runtime lists are read
 * off the maps; `tests/rendered/calendar-connect-control.test.tsx` holds each
 * equal to the server's own constant.
 */
import type { CalendarConnectOutcome, CalendarProviderId } from '@/app-layer/usecases/user-calendar-connection';
import type {
    CalendarConnectRefusal,
    CalendarConnectionState,
} from '@/app-layer/usecases/calendar-connectability';

export type { CalendarConnectOutcome, CalendarProviderId, CalendarConnectRefusal, CalendarConnectionState };

/** What `GET /calendar/connections` answers. Dates arrive as ISO strings. */
export interface CalendarConnectionView {
    id: string;
    provider: CalendarProviderId;
    connectedAt: string;
    revokedAt: string | null;
    lastPushedAt: string | null;
    disconnectRequestedAt: string | null;
    undeletedEventCount: number;
    state: CalendarConnectionState;
}

export interface CalendarProviderView {
    provider: CalendarProviderId;
    connectable: boolean;
    refusal: CalendarConnectRefusal | null;
}

export interface CalendarConnectionsResponse {
    connections: CalendarConnectionView[];
    providers: CalendarProviderView[];
}

/** The order the panel lists providers in, and the message key of each name. */
export const PROVIDER_NAME_KEY = {
    'google-calendar': 'provider.google-calendar',
    'outlook-calendar': 'provider.outlook-calendar',
} as const satisfies Record<CalendarProviderId, string>;
export const PROVIDER_ORDER = Object.keys(PROVIDER_NAME_KEY) as CalendarProviderId[];

export type OutcomeTone = 'success' | 'info' | 'error';

/** One message per callback outcome, and the notice's tone. */
export const OUTCOME_COPY = {
    connected: { key: 'outcome.connected', tone: 'success' },
    connect_declined: { key: 'outcome.connect_declined', tone: 'info' },
    provider_error: { key: 'outcome.provider_error', tone: 'error' },
    consent_withdrawn: { key: 'outcome.consent_withdrawn', tone: 'error' },
    no_refresh_token: { key: 'outcome.no_refresh_token', tone: 'error' },
    flow_invalid: { key: 'outcome.flow_invalid', tone: 'error' },
    connect_failed: { key: 'outcome.connect_failed', tone: 'error' },
} as const satisfies Record<CalendarConnectOutcome, { key: `outcome.${CalendarConnectOutcome}`; tone: OutcomeTone }>;

export function isConnectOutcome(value: string | null): value is CalendarConnectOutcome {
    return value !== null && Object.prototype.hasOwnProperty.call(OUTCOME_COPY, value);
}

/** Why a provider cannot be connected, worded for the person who cannot. */
export const REFUSAL_KEY = {
    NOT_CONFIGURED: 'refusal.NOT_CONFIGURED',
    ADMIN_CONSENT_NOT_GRANTED: 'refusal.ADMIN_CONSENT_NOT_GRANTED',
    ADMIN_CONSENT_WITHDRAWN: 'refusal.ADMIN_CONSENT_WITHDRAWN',
} as const satisfies Record<CalendarConnectRefusal, string>;

export function isConnectRefusal(value: unknown): value is CalendarConnectRefusal {
    return typeof value === 'string' && Object.prototype.hasOwnProperty.call(REFUSAL_KEY, value);
}

/** The state badge's label per connection state ("not connected" has no row). */
export const STATE_LABEL_KEY = {
    CONNECTED: 'state.connected',
    DISCONNECTING: 'state.disconnecting',
    DISCONNECTED: 'state.notConnected',
    STOPPED: 'state.stopped',
} as const satisfies Record<CalendarConnectionState, string>;

/** The query parameter the callback names its outcome in. */
export const OUTCOME_PARAM = 'calendar';
