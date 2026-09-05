import {
	InvalidAuthEntryError,
	type AuthStore,
	type AwsProfileAuthInfo,
} from '@humanlayer/agentlayer-provider-auth'
import { NODE_REGION_CONFIG_FILE_OPTIONS, NODE_REGION_CONFIG_OPTIONS } from '@smithy/config-resolver'
import { loadConfig } from '@smithy/node-config-provider'
import { readCodexBedrockConfig } from './codex-config'

export type CodexConnection =
	| { readonly type: 'chatgpt' }
	| {
		readonly type: 'bedrock'
		readonly profile?: string
		readonly region?: string
		readonly model?: string
		readonly baseURL?: string
	}

export type ResolvedCodexConnection =
	| { type: 'chatgpt' }
	| { type: 'custom-responses' }
	| { type: 'bedrock'; profile?: string; region: string; model: string; baseURL: string; endpointURL: string }

export interface ResolveCodexConnectionOptions {
	explicitConnection?: CodexConnection
	authStore: AuthStore
	selectedModelId: string
	codexHome?: string
	env?: NodeJS.ProcessEnv
	homeDirectory?: string
	hasLegacyOverride?: boolean
	regionProvider?: (profile?: string) => Promise<string>
}

export async function resolveCodexConnection(
	options: ResolveCodexConnectionOptions,
): Promise<ResolvedCodexConnection> {
	const env = options.env ?? process.env
	if (options.explicitConnection) {
		return options.explicitConnection.type === 'chatgpt'
			? { type: 'chatgpt' }
			: resolveBedrock(options.explicitConnection, options.selectedModelId, options.regionProvider)
	}

	const stored = await options.authStore.get('codex_bedrock')
	if (stored && stored.kind !== 'aws-profile') throw new InvalidAuthEntryError('codex_bedrock')
	if (stored?.kind === 'aws-profile') {
		if (stored.active === true) {
			return resolveBedrock(fromStored(stored), options.selectedModelId, options.regionProvider)
		}
		if (stored.active === false) return { type: 'chatgpt' }
	}
	if (options.hasLegacyOverride) return { type: 'custom-responses' }

	const config = await readCodexBedrockConfig({
		codexHome: options.codexHome,
		env,
		homeDirectory: options.homeDirectory,
	})
	if (config?.modelProvider === 'amazon-bedrock-runtime') {
		throw new Error('Codex model provider "amazon-bedrock-runtime" is not supported; use "amazon-bedrock".')
	}
	if (config?.modelProvider !== 'amazon-bedrock') return { type: 'chatgpt' }
	return resolveBedrock({
		type: 'bedrock',
		profile: stored?.profile ?? config.profile,
		region: stored?.region ?? config.region,
		model: stored?.model ?? config.model,
		baseURL: stored?.baseUrl ?? config.baseUrl,
	}, options.selectedModelId, options.regionProvider)
}

function fromStored(auth: AwsProfileAuthInfo): Extract<CodexConnection, { type: 'bedrock' }> {
	return {
		type: 'bedrock',
		profile: auth.profile,
		region: auth.region,
		model: auth.model,
		baseURL: auth.baseUrl,
	}
}

async function resolveBedrock(
	connection: Extract<CodexConnection, { type: 'bedrock' }>,
	selectedModelId: string,
	regionProvider: (profile?: string) => Promise<string> = resolveAwsRegion,
): Promise<ResolvedCodexConnection> {
	let region = connection.region
	if (!region) {
		try {
			region = await regionProvider(connection.profile)
		} catch {
			// Normalize the SDK's missing-region errors without exposing config contents.
		}
	}
	if (!region) {
		throw new Error('Amazon Bedrock configuration is incomplete: an AWS region could not be resolved.')
	}
	const baseURL = connection.baseURL ?? `https://bedrock-mantle.${region}.api.aws/openai/v1`
	const endpoint = parseResponsesURL(baseURL, 'Amazon Bedrock base URL')
	const model = connection.model ?? (selectedModelId.startsWith('openai.') ? selectedModelId : `openai.${selectedModelId}`)
	return { type: 'bedrock', profile: connection.profile, region, model, ...endpoint }
}

export function parseResponsesURL(rawValue: string, settingName: string): { baseURL: string; endpointURL: string } {
	let url: URL
	try {
		url = new URL(rawValue)
	} catch {
		throw new Error(`${settingName} must be an absolute HTTP or HTTPS URL.`)
	}
	if (url.username || url.password) throw new Error(`${settingName} must not contain a username or password.`)
	if (url.search || url.hash) throw new Error(`${settingName} must not contain a query string or fragment.`)
	if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHostname(url.hostname))) {
		throw new Error(`${settingName} must use HTTPS unless it points to a loopback host.`)
	}
	const normalizedPath = url.pathname.replace(/\/+$/, '')
	const isFullEndpoint = normalizedPath.endsWith('/responses')
	const basePath = isFullEndpoint ? normalizedPath.slice(0, -'/responses'.length) : normalizedPath
	url.pathname = basePath || '/'
	const baseURL = url.toString().replace(/\/$/, '')
	url.pathname = `${basePath}/responses` || '/responses'
	return { baseURL, endpointURL: url.toString() }
}

async function resolveAwsRegion(profile?: string): Promise<string> {
	return loadConfig(NODE_REGION_CONFIG_OPTIONS, {
		...NODE_REGION_CONFIG_FILE_OPTIONS,
		profile,
	})()
}

function isLoopbackHostname(hostname: string): boolean {
	const normalized = hostname.toLowerCase()
	if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized === '[::1]') return true
	const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized)
	return match !== null && Number(match[1]) === 127 && match.slice(1).every((part) => Number(part) <= 255)
}
