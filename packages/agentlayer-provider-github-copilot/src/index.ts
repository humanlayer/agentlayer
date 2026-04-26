export {
	buildCopilotHeaders,
	buildCopilotRequest,
	COPILOT_PROVIDER,
	type CopilotAuthInfo,
	type CopilotHeadersResult,
	type CopilotLanguageModelOptions,
	type CopilotProviderOptions,
	createCopilotLanguageModel,
	createCopilotProvider,
	createCopilotSdk,
	createCopilotSdkSettings,
	listCopilotModels,
	resolveCopilotAuth,
	SYNTHETIC_ATTACHMENT_PROMPT,
	shouldUseCopilotResponsesApi,
	startDeviceOAuth,
} from './copilot'
export {
	buildCopilotUserAgent,
	COPILOT_CLIENT_ID,
	COPILOT_PROVIDER_ID,
	type CopilotDeviceCodeResponse,
	type CopilotFetchLike,
	type DeviceAuthorizationResponse,
	type DeviceAuthorizationResult,
	getCopilotApiBaseUrl,
	getCopilotOAuthUrls,
	normalizeEnterpriseUrl,
	OAUTH_POLLING_SAFETY_MARGIN_MS,
	type StartCopilotDeviceOAuthOptions,
	startDeviceOAuth as startCopilotDeviceOAuth,
	writeCopilotOAuthTokens,
} from './copilot-oauth'
export { copilotModelsResponseSchema, getCopilotModels } from './models'
export type { OpenaiCompatibleProvider, OpenaiCompatibleProviderSettings } from './sdk/copilot'
export { createOpenaiCompatible, openaiCompatible } from './sdk/copilot'
export type { CopilotModelDefinition, CopilotModelMap } from './types'
