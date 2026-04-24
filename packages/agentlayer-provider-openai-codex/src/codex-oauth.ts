import { createServer } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import type { AuthStore, OAuthAuthInfo } from '@humanlayer/agentlayer-provider-auth'
import { type CodexTokenResponse, extractAccountId } from './codex-jwt'

export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const CODEX_ISSUER = 'https://auth.openai.com'
export const DEFAULT_OAUTH_PORT = 1455
export const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000

export interface PkceCodes {
	verifier: string
	challenge: string
}

export interface CodexOAuthSuccessResult {
	kind: 'success'
	auth: OAuthAuthInfo
}

export interface BrowserOAuthStartResult {
	url: string
	redirectUri: string
	state: string
	pkce: PkceCodes
	complete: () => Promise<CodexOAuthSuccessResult>
	cancel: () => Promise<void>
	stopServer: () => Promise<void>
}

export interface DeviceAuthorizationResponse {
	device_auth_id: string
	user_code: string
	interval: string
}

export interface DeviceAuthorizationResult {
	url: string
	userCode: string
	complete: () => Promise<CodexOAuthSuccessResult>
}

export type CodexFetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface OAuthServerOptions {
	port?: number
	hostname?: string
	timeoutMs?: number
}

export interface StartBrowserOAuthOptions extends OAuthServerOptions {
	store: AuthStore
	providerId?: string
	fetch?: CodexFetchLike
	now?: () => number
}

export interface StartDeviceOAuthOptions {
	store: AuthStore
	providerId?: string
	fetch?: CodexFetchLike
	now?: () => number
	version?: string
}

function getFetch(fetchFn?: CodexFetchLike): CodexFetchLike {
	return fetchFn ?? globalThis.fetch
}

function getNow(now?: () => number): () => number {
	return now ?? Date.now
}

export async function generatePKCE(): Promise<PkceCodes> {
	const verifier = generateRandomString(43)
	const encoder = new TextEncoder()
	const data = encoder.encode(verifier)
	const hash = await crypto.subtle.digest('SHA-256', data)
	const challenge = base64UrlEncode(hash)
	return { verifier, challenge }
}

export function generateRandomString(length: number): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'
	const bytes = crypto.getRandomValues(new Uint8Array(length))
	return Array.from(bytes)
		.map((byte) => chars[byte % chars.length])
		.join('')
}

export function base64UrlEncode(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer)
	const binary = String.fromCharCode(...bytes)
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function generateState(): string {
	return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer)
}

export function buildAuthorizeUrl(redirectUri: string, pkce: PkceCodes, state: string): string {
	const params = new URLSearchParams({
		response_type: 'code',
		client_id: CODEX_CLIENT_ID,
		redirect_uri: redirectUri,
		scope: 'openid profile email offline_access',
		code_challenge: pkce.challenge,
		code_challenge_method: 'S256',
		id_token_add_organizations: 'true',
		codex_cli_simplified_flow: 'true',
		state,
		originator: 'opencode',
	})

	return `${CODEX_ISSUER}/oauth/authorize?${params.toString()}`
}

export function buildBrowserOAuthRedirectUri(hostname: string, port: number): string {
	return `http://${hostname}:${port}/auth/callback`
}

export async function exchangeCodeForTokens(
	code: string,
	redirectUri: string,
	pkce: PkceCodes,
	fetchFn?: CodexFetchLike,
): Promise<CodexTokenResponse> {
	const response = await getFetch(fetchFn)(`${CODEX_ISSUER}/oauth/token`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'authorization_code',
			code,
			redirect_uri: redirectUri,
			client_id: CODEX_CLIENT_ID,
			code_verifier: pkce.verifier,
		}).toString(),
	})

	if (!response.ok) {
		throw new Error(`Token exchange failed: ${response.status}`)
	}

	return (await response.json()) as CodexTokenResponse
}

export async function refreshAccessToken(refreshToken: string, fetchFn?: CodexFetchLike): Promise<CodexTokenResponse> {
	const response = await getFetch(fetchFn)(`${CODEX_ISSUER}/oauth/token`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: refreshToken,
			client_id: CODEX_CLIENT_ID,
		}).toString(),
	})

	if (!response.ok) {
		throw new Error(`Token refresh failed: ${response.status}`)
	}

	return (await response.json()) as CodexTokenResponse
}

export async function writeOAuthTokens(
	store: AuthStore,
	providerId: string,
	tokens: CodexTokenResponse,
	now = Date.now,
): Promise<OAuthAuthInfo> {
	const auth: OAuthAuthInfo = {
		kind: 'oauth',
		accessToken: tokens.access_token ?? '',
		refreshToken: tokens.refresh_token,
		expiresAt: now() + (tokens.expires_in ?? 3600) * 1000,
		idToken: tokens.id_token,
		accountId: extractAccountId(tokens),
	}

	await store.set(providerId, auth)
	return auth
}

export async function startBrowserOAuth(options: StartBrowserOAuthOptions): Promise<BrowserOAuthStartResult> {
	const port = options.port ?? DEFAULT_OAUTH_PORT
	const hostname = options.hostname ?? 'localhost'
	const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000
	const providerId = options.providerId ?? 'codex'
	const now = getNow(options.now)
	const fetchFn = getFetch(options.fetch)
	const pkce = await generatePKCE()
	const state = generateState()
	const server = createServer()
	const redirectUri = buildBrowserOAuthRedirectUri(hostname, port)

	let completed = false
	let timeout: ReturnType<typeof setTimeout> | undefined
	let resolveCallback: ((tokens: CodexTokenResponse) => void) | undefined
	let rejectCallback: ((error: Error) => void) | undefined

	const callbackPromise = new Promise<CodexTokenResponse>((resolve, reject) => {
		resolveCallback = resolve
		rejectCallback = reject
	})

	server.on('request', (req, res) => {
		const url = new URL(req.url || '/', `http://${hostname}:${port}`)

		if (url.pathname === '/auth/callback') {
			const code = url.searchParams.get('code')
			const returnedState = url.searchParams.get('state')
			const error = url.searchParams.get('error')
			const errorDescription = url.searchParams.get('error_description')

			if (error) {
				const message = errorDescription || error
				rejectCallback?.(new Error(message))
				res.writeHead(200, { 'Content-Type': 'text/html' })
				res.end(renderErrorHtml(message))
				return
			}

			if (!code) {
				const message = 'Missing authorization code'
				rejectCallback?.(new Error(message))
				res.writeHead(400, { 'Content-Type': 'text/html' })
				res.end(renderErrorHtml(message))
				return
			}

			if (returnedState !== state) {
				const message = 'Invalid state - potential CSRF attack'
				rejectCallback?.(new Error(message))
				res.writeHead(400, { 'Content-Type': 'text/html' })
				res.end(renderErrorHtml(message))
				return
			}

			exchangeCodeForTokens(code, redirectUri, pkce, fetchFn)
				.then((tokens) => resolveCallback?.(tokens))
				.catch((error) => rejectCallback?.(toError(error)))

			res.writeHead(200, { 'Content-Type': 'text/html' })
			res.end(renderSuccessHtml())
			return
		}

		if (url.pathname === '/cancel') {
			rejectCallback?.(new Error('Login cancelled'))
			res.writeHead(200, { 'Content-Type': 'text/plain' })
			res.end('Login cancelled')
			return
		}

		res.writeHead(404, { 'Content-Type': 'text/plain' })
		res.end('Not found')
	})

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject)
		if (options.hostname) {
			server.listen(port, options.hostname, () => resolve())
			return
		}
		server.listen(port, () => resolve())
	})

	const stopServer = async () => {
		if (completed) return
		completed = true
		if (timeout) clearTimeout(timeout)
		await new Promise<void>((resolve, reject) => {
			server.close((error) => {
				if (error) reject(error)
				else resolve()
			})
		})
	}

	timeout = setTimeout(() => {
		rejectCallback?.(new Error('OAuth callback timeout - authorization took too long'))
	}, timeoutMs)

	return {
		url: buildAuthorizeUrl(redirectUri, pkce, state),
		redirectUri,
		state,
		pkce,
		async complete() {
			try {
				const tokens = await callbackPromise
				const auth = await writeOAuthTokens(options.store, providerId, tokens, now)
				return { kind: 'success', auth }
			} finally {
				await stopServer()
			}
		},
		async cancel() {
			rejectCallback?.(new Error('Login cancelled'))
			await stopServer()
		},
		stopServer,
	}
}

export async function startDeviceOAuth(options: StartDeviceOAuthOptions): Promise<DeviceAuthorizationResult> {
	const providerId = options.providerId ?? 'codex'
	const fetchFn = getFetch(options.fetch)
	const now = getNow(options.now)
	const userAgent = buildCodexUserAgent(options.version ?? '0.0.0')
	const deviceResponse = await fetchFn(`${CODEX_ISSUER}/api/accounts/deviceauth/usercode`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'User-Agent': userAgent,
		},
		body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
	})

	if (!deviceResponse.ok) {
		throw new Error('Failed to initiate device authorization')
	}

	const deviceData = (await deviceResponse.json()) as DeviceAuthorizationResponse
	const interval = Math.max(Number.parseInt(deviceData.interval, 10) || 5, 1) * 1000

	return {
		url: `${CODEX_ISSUER}/codex/device`,
		userCode: deviceData.user_code,
		async complete() {
			while (true) {
				const response = await fetchFn(`${CODEX_ISSUER}/api/accounts/deviceauth/token`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'User-Agent': userAgent,
					},
					body: JSON.stringify({
						device_auth_id: deviceData.device_auth_id,
						user_code: deviceData.user_code,
					}),
				})

				if (response.ok) {
					const data = (await response.json()) as { authorization_code: string; code_verifier: string }
					const tokens = await exchangeCodeForTokens(
						data.authorization_code,
						`${CODEX_ISSUER}/deviceauth/callback`,
						{ verifier: data.code_verifier, challenge: '' },
						fetchFn,
					)
					const auth = await writeOAuthTokens(options.store, providerId, tokens, now)
					return { kind: 'success', auth }
				}

				if (response.status !== 403 && response.status !== 404) {
					throw new Error(`Device authorization failed: ${response.status}`)
				}

				await sleep(interval + OAUTH_POLLING_SAFETY_MARGIN_MS)
			}
		},
	}
}

export function buildCodexUserAgent(version: string): string {
	return `opencode/${version}`
}

function renderSuccessHtml(): string {
	return `<!doctype html>
<html>
  <head>
    <title>OpenCode - Codex Authorization Successful</title>
  </head>
  <body>
    <h1>Authorization Successful</h1>
    <p>You can close this window and return to OpenCode.</p>
    <script>
      setTimeout(() => window.close(), 2000)
    </script>
  </body>
</html>`
}

function renderErrorHtml(error: string): string {
	return `<!doctype html>
<html>
  <head>
    <title>OpenCode - Codex Authorization Failed</title>
  </head>
  <body>
    <h1>Authorization Failed</h1>
    <p>${error}</p>
  </body>
</html>`
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error))
}
