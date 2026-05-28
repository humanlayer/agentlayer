// --- Providers ---
export { type CodexEffectProviderOptions, createCodexEffectProvider } from './providers/websocket-codex-provider'
export {
	type CodexCustomResponsesProviderOptions,
	createCodexCustomResponsesProvider,
} from './providers/custom-codex-provider'
export { type CodexResponsesProviderOptions, createCodexResponsesProvider } from './providers/aisdk-codex-provider'

// --- Shared constants ---
export {
	CODEX_API_ENDPOINT,
	CODEX_DEFAULT_VERSION,
	CODEX_FAST_SERVICE_TIER,
	CODEX_FLEX_SERVICE_TIER,
	CODEX_PROVIDER,
	CODEX_PROVIDER_ID,
} from './shared/constants'

// --- Auth ---
export { resolveCodexAuth, buildCodexUserAgent } from './shared/auth'
export { normalizeCodexServiceTier } from './shared/service-tier'
export type { CodexProviderOptions, CodexRequestOptions } from './shared/types'

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

// --- JWT ---
export * from './jwt'

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
export type { CodexRequestBody } from './legacy'
