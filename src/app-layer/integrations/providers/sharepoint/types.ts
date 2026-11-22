/**
 * Microsoft Graph SharePoint types (SP-1).
 *
 * Minimal, hand-typed shapes for the Graph SharePoint surface IC uses — we only
 * model the fields we read, not the full Graph schema. All optional where Graph
 * may omit them so the client/mapper stay defensive.
 *
 * @module integrations/providers/sharepoint/types
 */

/** A Graph `site` resource (a SharePoint site collection / subsite). */
export interface SpSite {
    id: string;
    displayName?: string;
    name?: string;
    webUrl?: string;
}

/** A Graph `drive` resource (a SharePoint document library). */
export interface SpDrive {
    id: string;
    name?: string;
    driveType?: string;
    webUrl?: string;
}

/** A Graph `driveItem` resource (a folder or file in a library). */
export interface SpDriveItem {
    id: string;
    name?: string;
    webUrl?: string;
    /** Changes on content OR metadata edits. */
    eTag?: string;
    /** Content tag — changes ONLY on content edits (preferred for change-detection). */
    cTag?: string;
    size?: number;
    lastModifiedDateTime?: string;
    /** Present on folders. */
    folder?: { childCount?: number };
    /** Present on files. */
    file?: { mimeType?: string };
    /** Present on a delta page when the item was removed. */
    deleted?: { state?: string };
    parentReference?: { driveId?: string; id?: string; path?: string };
}

/** A page of children with the Graph cursor for the next page. */
export interface SpChildrenPage {
    items: SpDriveItem[];
    nextLink?: string;
}

/** A delta page: changed items plus the opaque token for the next delta query. */
export interface SpDeltaPage {
    items: SpDriveItem[];
    /**
     * Opaque cursor to pass to the next `getDelta`.
     *
     * When `truncated` is false this is a DELTA token: the walk finished and
     * the next call asks only for what changed after it. When `truncated` is
     * true it is a RESUME cursor for the same enumeration, prefixed with the
     * Graph query parameter it belongs to (#5555).
     */
    deltaToken?: string;
    /**
     * The walk stopped at its page bound with changes still unread (#5555).
     *
     * The caller must not report this drive as cleanly synced: items beyond the
     * bound have not been checked for a change or a deletion. Storing the
     * cursor above is what lets the next run carry on instead of restarting and
     * stopping in the same place for ever.
     */
    truncated?: boolean;
}

/** A Graph change-notification subscription (SP-4). */
export interface SpSubscription {
    id: string;
    resource?: string;
    expirationDateTime?: string;
    notificationUrl?: string;
    clientState?: string;
}
