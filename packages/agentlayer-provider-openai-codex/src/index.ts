// --- Providers ---

export type CodexProviderMode = 'sse' | 'websockets'

// --- JWT ---
export * from './jwt'
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
