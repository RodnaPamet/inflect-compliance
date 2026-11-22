/**
 * How many risks one CSV import may carry.
 *
 * Shared by the request schema (`BulkImportRisksSchema`, which refuses the
 * whole batch above it) and the import page, which used to offer any number
 * of rows and so sent batches the server always refused (#5313).
 * Dependency-free so the page can import it.
 */
export const RISK_IMPORT_MAX_ROWS = 500;
