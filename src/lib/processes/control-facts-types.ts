/**
 * The wire shape of `GET /processes/:id/control-facts`.
 *
 * In its own dependency-free module so the canvas (a client bundle) and the
 * usecase (which reaches the database) share one definition without the client
 * importing the usecase's module graph.
 */

/** The most ids one request may name: a map's node cap. */
export const MAX_CONTROL_FACT_IDS = 500;

export interface ControlFact {
    id: string;
    code: string | null;
    name: string;
    status: string;
    /** 0–100, or null when never assessed. */
    effectiveness: number | null;
    /** ISO date-time, or null when never tested. */
    lastTested: string | null;
}

export interface ProcessMapControlFacts {
    /** True when the caller may read the map but not controls. */
    restricted: boolean;
    /** Facts for every requested id that is a live control of this tenant. */
    controls: Record<string, ControlFact>;
    /** Requested ids with no live control behind them (deleted, or never this tenant's). */
    missing: string[];
}
