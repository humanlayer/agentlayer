import { describe, expect, mock, test } from 'bun:test'
import type { AwsCredentialIdentity } from '@smithy/types'
import {
	fetchWithBedrockAuth,
	makeBedrockAuth,
	type BedrockAuth,
} from '../src/codex/bedrock-auth'

const credentials: AwsCredentialIdentity = {
	accessKeyId: 'secret-access-id',
	secretAccessKey: 'secret-access-key',
	sessionToken: 'secret-session-token',
}

describe('makeBedrockAuth', () => {
	test('caches, expires, and single-flights generated tokens', async () => {
		let now = 1_000_000
		let release: (() => void) | undefined
		const barrier = new Promise<void>((resolve) => { release = resolve })
		const provider = mock(async () => credentials)
		const tokenGenerator = mock(async () => {
			await barrier
			return `token-${tokenGenerator.mock.calls.length}`
		})
		const auth = makeBedrockAuth({
			region: 'us-east-1',
			now: () => now,
			credentialProviderFactory: () => provider,
			tokenGenerator,
		})

		const pending = [auth.getToken(), auth.getToken(), auth.getToken()]
		release!()
		expect(await Promise.all(pending)).toEqual(['token-1', 'token-1', 'token-1'])
		expect(tokenGenerator).toHaveBeenCalledTimes(1)
		expect(await auth.getToken()).toBe('token-1')

		now += 12 * 60 * 60 * 1000 - 5 * 60 * 1000
		expect(await auth.getToken()).toBe('token-2')
		expect(tokenGenerator).toHaveBeenCalledTimes(2)
	})

	test('uses AWS credential expiration to shorten cache lifetime', async () => {
		let now = 5_000_000
		const tokenGenerator = mock(async () => `token-${tokenGenerator.mock.calls.length}`)
		const auth = makeBedrockAuth({
			region: 'us-east-1',
			now: () => now,
			credentialProviderFactory: () => async () => ({
				...credentials,
				expiration: new Date(5_000_000 + 10 * 60 * 1000),
			}),
			tokenGenerator,
		})

		expect(await auth.getToken()).toBe('token-1')
		now += 5 * 60 * 1000
		expect(await auth.getToken()).toBe('token-2')
	})

	test('rebuilds provider after invalidation and redacts credential failures', async () => {
		const providerFactory = mock(() => async () => credentials)
		const tokenGenerator = mock(async () => 'token')
		const auth = makeBedrockAuth({
			profile: 'work',
			region: 'us-east-1',
			credentialProviderFactory: providerFactory,
			tokenGenerator,
		})
		await auth.getToken()
		auth.invalidate()
		await auth.getToken()
		expect(providerFactory).toHaveBeenCalledTimes(2)

		const failing = makeBedrockAuth({
			profile: 'work',
			region: 'us-east-1',
			credentialProviderFactory: () => async () => { throw new Error(JSON.stringify(credentials)) },
		})
		let message = ''
		try { await failing.getToken() } catch (error) { message = String(error) }
		expect(message).toContain('profile "work"')
		for (const secret of Object.values(credentials)) expect(message).not.toContain(String(secret))
	})

	test('invalidation supersedes an in-flight refresh without publishing its stale token', async () => {
		let releaseStale: ((token: string) => void) | undefined
		let releaseCurrent: ((token: string) => void) | undefined
		const staleToken = new Promise<string>((resolve) => { releaseStale = resolve })
		const currentToken = new Promise<string>((resolve) => { releaseCurrent = resolve })
		const providerFactory = mock(() => async () => credentials)
		const tokenGenerator = mock(async () =>
			tokenGenerator.mock.calls.length === 1 ? staleToken : currentToken)
		const auth = makeBedrockAuth({
			region: 'us-east-1',
			credentialProviderFactory: providerFactory,
			tokenGenerator,
		})

		const staleRequest = auth.getToken()
		while (tokenGenerator.mock.calls.length < 1) await Promise.resolve()
		auth.invalidate()
		const currentRequest = auth.getToken()
		while (tokenGenerator.mock.calls.length < 2) await Promise.resolve()
		releaseStale!('stale-token')
		const joinedRequest = auth.getToken()
		expect(tokenGenerator).toHaveBeenCalledTimes(2)
		releaseCurrent!('current-token')

		expect(await Promise.all([staleRequest, currentRequest, joinedRequest])).toEqual([
			'current-token',
			'current-token',
			'current-token',
		])
		expect(await auth.getToken()).toBe('current-token')
		expect(providerFactory).toHaveBeenCalledTimes(2)
	})
})

describe('fetchWithBedrockAuth', () => {
	function auth(tokens: string[]): BedrockAuth & { invalidations: number } {
		return {
			invalidations: 0,
			async getToken() { return tokens.shift() ?? 'last-token' },
			invalidate() { this.invalidations++ },
		}
	}

	test('replaces placeholder authorization and preserves successful streaming bodies', async () => {
		const bedrockAuth = auth(['bedrock-token'])
		const body = new ReadableStream({ start(controller) { controller.enqueue('chunk'); controller.close() } })
		const requestFetch = mock(async (input: string | URL | Request) => {
			expect(input).toBeInstanceOf(Request)
			expect(new Headers((input as Request).headers).get('authorization')).toBe('Bearer bedrock-token')
			return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
		})
		const response = await fetchWithBedrockAuth(bedrockAuth, requestFetch, 'https://example.test', {
			headers: { authorization: 'Bearer placeholder' },
		})
		expect(await response.text()).toBe('chunk')
		expect(requestFetch).toHaveBeenCalledTimes(1)
	})

	test('preserves Request and init headers and replays a Request body on auth retry', async () => {
		const bedrockAuth = auth(['old-token', 'new-token'])
		const attempts: Array<{ body: string; headers: Headers }> = []
		const requestFetch = mock(async (input: string | URL | Request) => {
			const request = input as Request
			attempts.push({ body: await request.text(), headers: request.headers })
			return attempts.length === 1 ? new Response('', { status: 401 }) : new Response('ok')
		})
		const request = new Request('https://example.test/responses', {
			method: 'POST',
			headers: { authorization: 'Bearer placeholder', 'x-request-header': 'request' },
			body: 'replayable payload',
		})

		const response = await fetchWithBedrockAuth(bedrockAuth, requestFetch, request, {
			headers: { 'x-init-header': 'init' },
		})

		expect(await response.text()).toBe('ok')
		expect(attempts.map((attempt) => attempt.body)).toEqual(['replayable payload', 'replayable payload'])
		expect(attempts.map((attempt) => attempt.headers.get('authorization'))).toEqual([
			'Bearer old-token',
			'Bearer new-token',
		])
		for (const attempt of attempts) {
			expect(attempt.headers.get('x-request-header')).toBe('request')
			expect(attempt.headers.get('x-init-header')).toBe('init')
		}
	})

	test.each([
		new Response('', { status: 401 }),
		new Response(JSON.stringify({ code: 'ExpiredToken' }), { status: 403 }),
	])('invalidates and retries one qualifying auth failure', async (first) => {
		const bedrockAuth = auth(['old-token', 'new-token'])
		const responses = [first, new Response('still forbidden', { status: 401 })]
		const requestFetch = mock(async () => responses.shift()!)
		const response = await fetchWithBedrockAuth(bedrockAuth, requestFetch, 'https://example.test')
		expect(response.status).toBe(401)
		expect(bedrockAuth.invalidations).toBe(1)
		expect(requestFetch).toHaveBeenCalledTimes(2)
	})

	test('does not retry unrelated forbidden responses', async () => {
		const bedrockAuth = auth(['token'])
		const requestFetch = mock(async () => new Response('AccessDeniedException', { status: 403 }))
		expect((await fetchWithBedrockAuth(bedrockAuth, requestFetch, 'https://example.test')).status).toBe(403)
		expect(requestFetch).toHaveBeenCalledTimes(1)
		expect(bedrockAuth.invalidations).toBe(0)
	})

	test('bounds forbidden-response inspection without waiting for the full body', async () => {
		let pulls = 0
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls++
				if (pulls === 1) controller.enqueue(new Uint8Array(16_384).fill(65))
				// A second pull intentionally never closes. Full buffering would hang.
			},
		})
		const bedrockAuth = auth(['token'])
		const requestFetch = mock(async () => new Response(body, { status: 403 }))
		const result = await Promise.race([
			fetchWithBedrockAuth(bedrockAuth, requestFetch, 'https://example.test'),
			Bun.sleep(500).then(() => { throw new Error('403 inspection did not stop at its byte limit') }),
		])

		expect(result.status).toBe(403)
		expect(requestFetch).toHaveBeenCalledTimes(1)
		// Response.clone() may prefetch for each tee branch, but inspection still
		// returns after the first bounded chunk instead of draining the stream.
		expect(pulls).toBeLessThanOrEqual(3)
	})
})
