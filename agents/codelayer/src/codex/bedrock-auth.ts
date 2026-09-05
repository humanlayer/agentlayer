import { getToken as generateBedrockToken } from '@aws/bedrock-token-generator'
import { fromIni, fromNodeProviderChain } from '@aws-sdk/credential-providers'
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from '@smithy/types'

const TOKEN_LIFETIME_SECONDS = 12 * 60 * 60
const REFRESH_BUFFER_MS = 5 * 60 * 1000

export interface BedrockAuth {
	getToken(): Promise<string>
	invalidate(): void
}

export interface BedrockAuthDependencies {
	now?: () => number
	credentialProviderFactory?: (profile?: string) => AwsCredentialIdentityProvider
	tokenGenerator?: (options: {
		credentials: AwsCredentialIdentity
		region: string
		expiresInSeconds: number
	}) => Promise<string>
}

export interface MakeBedrockAuthOptions extends BedrockAuthDependencies {
	profile?: string
	region: string
}

export type BedrockFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export class BedrockCredentialsUnavailableError extends Error {
	constructor(profile?: string) {
		super(
			profile
				? `AWS credentials for profile "${profile}" are unavailable or expired. Refresh the profile with your normal AWS login command, then retry this prompt. HumanLayer does not need to restart.`
				: 'AWS credentials are unavailable or expired. Refresh them with your normal AWS login command, then retry this prompt. HumanLayer does not need to restart.',
		)
		this.name = 'BedrockCredentialsUnavailableError'
	}
}

export function makeBedrockAuth(options: MakeBedrockAuthOptions): BedrockAuth {
	const now = options.now ?? Date.now
	const providerFactory = options.credentialProviderFactory ?? ((profile) =>
		profile
			? fromIni({ profile, clientConfig: { region: options.region } })
			: fromNodeProviderChain({ clientConfig: { region: options.region } }))
	const tokenGenerator = options.tokenGenerator ?? generateBedrockToken
	let credentialProvider: AwsCredentialIdentityProvider | undefined
	let token: string | undefined
	let refreshAt: number | undefined
	let refresh: Promise<string> | undefined
	let generation = 0

	const invalidate = () => {
		generation++
		credentialProvider = undefined
		token = undefined
		refreshAt = undefined
		refresh = undefined
	}

	const performRefresh = async (refreshGeneration: number): Promise<string> => {
		try {
			const provider = credentialProvider ?? providerFactory(options.profile)
			if (refreshGeneration === generation) credentialProvider = provider
			const credentials = await provider()
			const generatedAt = now()
			const generatedToken = await tokenGenerator({
				credentials,
				region: options.region,
				expiresInSeconds: TOKEN_LIFETIME_SECONDS,
			})
			const tokenExpiry = generatedAt + TOKEN_LIFETIME_SECONDS * 1000
			const credentialExpiry = credentials.expiration?.getTime()
			const effectiveExpiry = credentialExpiry === undefined
				? tokenExpiry
				: Math.min(tokenExpiry, credentialExpiry)
			const remaining = Math.max(0, effectiveExpiry - generatedAt)
			if (refreshGeneration !== generation) return getToken()
			token = generatedToken
			refreshAt = remaining <= REFRESH_BUFFER_MS
				? generatedAt + remaining / 2
				: effectiveExpiry - REFRESH_BUFFER_MS
			return generatedToken
		} catch {
			if (refreshGeneration !== generation) return getToken()
			invalidate()
			throw new BedrockCredentialsUnavailableError(options.profile)
		}
	}

	const getToken = async (): Promise<string> => {
		if (token !== undefined && refreshAt !== undefined && now() < refreshAt) return token
		if (refresh) return refresh
		const refreshGeneration = generation
		const nextRefresh = performRefresh(refreshGeneration)
		refresh = nextRefresh
		void nextRefresh.finally(() => {
			if (refresh === nextRefresh) refresh = undefined
		}).catch(() => {})
		return nextRefresh
	}

	return {
		getToken,
		invalidate,
	}
}

export async function isBedrockAuthenticationFailure(response: Response): Promise<boolean> {
	if (response.status === 401) return true
	if (response.status !== 403) return false
	try {
		const body = await readResponsePrefix(response, 16_384)
		return ['ExpiredToken', 'UnrecognizedClientException', 'InvalidClientTokenId'].some((code) =>
			body.includes(code))
	} catch {
		return false
	}
}

async function readResponsePrefix(response: Response, maximumBytes: number): Promise<string> {
	const body = response.clone().body
	if (!body) return ''
	const reader = body.getReader()
	const decoder = new TextDecoder()
	let result = ''
	let bytesRead = 0
	try {
		while (bytesRead < maximumBytes) {
			const { done, value } = await reader.read()
			if (done) break
			const remaining = maximumBytes - bytesRead
			const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value
			bytesRead += chunk.byteLength
			result += decoder.decode(chunk, { stream: bytesRead < maximumBytes })
		}
		result += decoder.decode()
		return result
	} finally {
		if (bytesRead >= maximumBytes) void reader.cancel().catch(() => {})
		reader.releaseLock()
	}
}

export async function fetchWithBedrockAuth(
	auth: BedrockAuth,
	fetch: BedrockFetch,
	input: string | URL | Request,
	init?: RequestInit,
): Promise<Response> {
	const headers = new Headers(input instanceof Request ? input.headers : undefined)
	new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
	const request = input instanceof Request
		? new Request(input, { ...init, headers })
		: new Request(input.toString(), { ...init, headers })
	const attempts = [request.clone() as Request, request.clone() as Request]
	const send = async (attempt: Request) => {
		const headers = new Headers(attempt.headers)
		headers.set('authorization', `Bearer ${await auth.getToken()}`)
		return fetch(new Request(attempt, { headers }))
	}

	const first = await send(attempts[0]!)
	if (!(await isBedrockAuthenticationFailure(first))) return first
	auth.invalidate()
	return send(attempts[1]!)
}
