// --- Providers ---

export type CodexProviderMode = 'sse' | 'aisdk_responses' | 'websockets'

// --- JWT ---
export * from './jwt'
export type { CodexRequestBody } from './legacy'
// --- Legacy (from old codex.ts — keep for backward compat until removed) ---
export {
	buildCodexHeaders,
	buildCodexRequestBody,
	createCodexLanguageModel,
	createCodexProvider,
	createCodexSseStream,
	parseCodexSseResponse,
	prepareCodexRequest,
	streamPartsToGenerateResult,
	transformCodexPrompt,
} from './legacy'
// --- OAuth ---
export {
	type BrowserOAuthStartResult,
	buildAuthorizeUrl,
	buildBrowserOAuthRedirectUri,
	buildCodexUserAgent as buildCodexOAuthUserAgent,
	CODEX_CLIENT_ID,
	CODEX_ISSUER,
	type CodexFetchLike,
	type CodexOAuthSuccessResult,
	DEFAULT_OAUTH_PORT,
	type DeviceAuthorizationResponse,
	type DeviceAuthorizationResult,
	exchangeCodeForTokens,
	generatePKCE,
	generateRandomString,
	generateState,
	OAUTH_POLLING_SAFETY_MARGIN_MS,
	type OAuthServerOptions,
	type PkceCodes,
	refreshAccessToken,
	type StartBrowserOAuthOptions,
	type StartDeviceOAuthOptions,
	startBrowserOAuth,
	startDeviceOAuth,
	writeOAuthTokens,
} from './oauth'
export { type CodexResponsesProviderOptions, createCodexResponsesProvider } from './providers/aisdk-codex-provider'
export { type CodexSseVendorProviderOptions, createCodexSseVendorProvider } from './providers/sse-vendor-provider'
export { type CodexEffectProviderOptions, createCodexEffectProvider } from './providers/websockets-vendor-provider'
// --- Auth ---
export { buildCodexUserAgent, resolveCodexAuth } from './shared/auth'
// --- Shared constants ---
export {
	CODEX_API_ENDPOINT,
	CODEX_DEFAULT_VERSION,
	CODEX_FAST_SERVICE_TIER,
	CODEX_FLEX_SERVICE_TIER,
	CODEX_HEADER_TIMEOUT_MS,
	CODEX_PROVIDER,
	CODEX_PROVIDER_ID,
	CODEX_WEBSOCKET_CONNECT_TIMEOUT_MS,
} from './shared/constants'
// --- Diagnostics ---
export { type CodexDiagnosticsLayerOptions, makeCodexDiagnosticsLayer } from './shared/diagnostics'
export { normalizeCodexServiceTier } from './shared/service-tier'
export type {
	CodexDiagnosticRecord,
	CodexDiagnosticSeverity,
	CodexDiagnosticsContext,
	CodexDiagnosticTransport,
	CodexProviderOptions,
	CodexRequestOptions,
} from './shared/types'
