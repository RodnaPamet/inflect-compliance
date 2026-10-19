/**
 * `@inflect/agent-harness-scanner` — the reference harness scanner (#3678).
 * See README.md for what it reads, what it may import, and how to run it.
 */
export { parseScannerConfig, ScannerConfigSchema, ConfigError, credentialEnvNames, type ScannerConfig } from './config';
export { createSourceWire, MAX_RESPONSE_BYTES, MAX_SOURCE_BYTES, type FetchLike, type ReadOnlyHttp, type TokenExchange } from './http';
export { jsonLineLog, type ScannerLog } from './log';
export { postReport, ingestUrl, type PostResult } from './post';
export { buildReportBody, signReport, rawPublicKeyHex, ReportRefusedLocally, type ScanIdentity } from './report';
export { buildSources, loadSigningKey, runScan, scanAndPost, type Env, type ScanDeps } from './scan';
export { isDeclaredRequest, scannerManifestHash, SCANNER_SURFACE, SCANNER_VERSION } from './scanner-surface';
export { runOnSchedule } from './schedule';
export {
    SourceReadError,
    type HarnessSource,
    type Observation,
    type SourceContext,
    type SourceKind,
    type SourceRead,
} from './source';
export { azureKeyVaultSource, type AzureKeyVaultSourceOptions } from './sources/azure-key-vault';
export { langchainCodeSource, scanLangChainCode, type LangChainCodeSourceOptions } from './sources/langchain';
export type { DetectedAgent, DetectedCredential, DetectedModel, DetectedTool } from './sources/code/recognize';
export { oktaSource, type OktaSourceOptions } from './sources/okta';
