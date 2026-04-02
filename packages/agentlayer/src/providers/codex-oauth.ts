import { writeAuth } from './auth'
import { extractAccountId } from './codex-jwt'

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const ISSUER = 'https://auth.openai.com'
const OAUTH_PORT = 1455

interface TokenResponse {
	id_token?: string
	access_token: string
	refresh_token: string
	expires_in?: number
}

// --- PKCE Utilities ---

function generateRandomString(length: number): string {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'
	const values = crypto.getRandomValues(new Uint8Array(length))
	return Array.from(values, (v) => alphabet[v % alphabet.length]).join('')
}

function base64UrlEncode(buffer: ArrayBuffer | Uint8Array): string {
	const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer
	return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function generatePKCE() {
	const verifier = generateRandomString(43)
	const data = new TextEncoder().encode(verifier)
	const hash = await crypto.subtle.digest('SHA-256', data)
	const challenge = base64UrlEncode(hash)
	return { verifier, challenge }
}

async function exchangeCodeForTokens(code: string, redirectUri: string, codeVerifier: string): Promise<TokenResponse> {
	const resp = await fetch(`${ISSUER}/oauth/token`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'authorization_code',
			code,
			redirect_uri: redirectUri,
			client_id: CLIENT_ID,
			code_verifier: codeVerifier,
		}),
	})
	if (!resp.ok) throw new Error(`Token exchange failed: ${resp.status}`)
	return resp.json() as Promise<TokenResponse>
}

async function persistCodexTokens(tokens: TokenResponse): Promise<void> {
	const accountId = extractAccountId(tokens)
	await writeAuth('openai', {
		type: 'oauth',
		refresh: tokens.refresh_token,
		access: tokens.access_token,
		expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
		...(accountId ? { accountId } : {}),
	})
}

// --- PKCE Browser Flow ---

export interface CodexPkceFlowOptions {
	onOpenUrl?: (url: string) => void
}

export async function codexPkceFlow(opts?: CodexPkceFlowOptions): Promise<void> {
	const pkce = await generatePKCE()
	const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)))
	const redirectUri = `http://localhost:${OAUTH_PORT}/auth/callback`

	const authUrl = new URL(`${ISSUER}/oauth/authorize`)
	authUrl.searchParams.set('client_id', CLIENT_ID)
	authUrl.searchParams.set('response_type', 'code')
	authUrl.searchParams.set('redirect_uri', redirectUri)
	authUrl.searchParams.set('scope', 'openid offline_access')
	authUrl.searchParams.set('state', state)
	authUrl.searchParams.set('code_challenge', pkce.challenge)
	authUrl.searchParams.set('code_challenge_method', 'S256')
	authUrl.searchParams.set('codex_cli_simplified_flow', 'true')
	authUrl.searchParams.set('originator', 'humanlayer-agent-sdk')

	return new Promise<void>((resolve, reject) => {
		const server = Bun.serve({
			port: OAUTH_PORT,
			async fetch(req: Request) {
				const url = new URL(req.url)
				if (url.pathname === '/auth/callback') {
					const error = url.searchParams.get('error')
					if (error) {
						server.stop()
						reject(new Error(`OAuth error: ${error}`))
						return new Response('Authentication failed. You can close this tab.', { status: 400 })
					}
					const code = url.searchParams.get('code')
					const returnedState = url.searchParams.get('state')
					if (returnedState !== state || !code) {
						server.stop()
						reject(new Error('Invalid state or missing code'))
						return new Response('Authentication failed. You can close this tab.', { status: 400 })
					}
					try {
						const tokens = await exchangeCodeForTokens(code, redirectUri, pkce.verifier)
						await persistCodexTokens(tokens)
						server.stop()
						resolve()
						return new Response('Authentication successful! You can close this tab.')
					} catch (e) {
						server.stop()
						reject(e)
						return new Response('Authentication failed. You can close this tab.', { status: 500 })
					}
				}
				return new Response('Not found', { status: 404 })
			},
		})

		opts?.onOpenUrl?.(authUrl.toString())
	})
}

// --- Device Flow ---

export interface CodexDeviceFlowOptions {
	onUserCode?: (code: string, uri: string) => void
}

export async function codexDeviceFlow(opts?: CodexDeviceFlowOptions): Promise<void> {
	// 1. Initiate device flow
	const initResp = await fetch(`${ISSUER}/api/accounts/deviceauth/usercode`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ client_id: CLIENT_ID }),
	})
	if (!initResp.ok) throw new Error(`Device flow initiation failed: ${initResp.status}`)

	const deviceInit = (await initResp.json()) as {
		device_auth_id: string
		user_code: string
		interval: string
	}
	const { device_auth_id, user_code, interval } = deviceInit

	opts?.onUserCode?.(user_code, `${ISSUER}/codex/device`)

	// 2. Poll for authorization
	const pollInterval = Math.max(parseInt(interval, 10) || 5, 1) * 1000 + 3000
	while (true) {
		await new Promise((r) => setTimeout(r, pollInterval))

		const pollResp = await fetch(`${ISSUER}/api/accounts/deviceauth/token`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ device_auth_id, user_code }),
		})

		if (pollResp.ok) {
			const pollData = (await pollResp.json()) as {
				authorization_code: string
				code_verifier: string
			}
			const { authorization_code, code_verifier } = pollData
			// Exchange with server-generated PKCE
			const tokens = await exchangeCodeForTokens(
				authorization_code,
				`${ISSUER}/deviceauth/callback`,
				code_verifier,
			)
			await persistCodexTokens(tokens)
			return
		}

		if (pollResp.status === 403 || pollResp.status === 404) {
			continue // User hasn't completed auth yet
		}

		throw new Error(`Device flow polling failed: ${pollResp.status}`)
	}
}
