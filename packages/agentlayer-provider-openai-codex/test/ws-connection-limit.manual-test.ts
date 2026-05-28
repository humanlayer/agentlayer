/**
 * Empirical test to determine the concurrent WebSocket connection limit
 * for the Codex endpoint at wss://chatgpt.com/backend-api/codex/responses.
 *
 * Run with real credentials:
 *   bun test packages/agentlayer-provider-openai-codex/test/ws-connection-limit.test.ts
 *
 * Requires auth stored via `humanlayer auth login codex`.
 */
import { describe, test } from 'bun:test'
import { ensureFileAuthStore } from '@humanlayer/agentlayer-provider-auth'
import { buildCodexUserAgent, resolveCodexAuth } from '../src/shared/auth'
import { CODEX_API_ENDPOINT, CODEX_DEFAULT_VERSION } from '../src/shared/constants'

const WS_URL = CODEX_API_ENDPOINT.replace(/\/responses$/, '/responses').replace('https://', 'wss://')

const MINIMAL_REQUEST = {
	type: 'response.create',
	model: 'gpt-5.5',
	instructions: 'Reply with exactly one word: ok',
	input: [{ role: 'user', content: [{ type: 'input_text', text: 'say ok' }] }],
	store: false,
	reasoning: { effort: 'low', summary: 'auto' },
}

interface ConnectionResult {
	index: number
	status: 'connected' | 'message-received' | 'completed' | 'error'
	error?: string
	firstEventType?: string
	durationMs: number
}

async function resolveHeaders(): Promise<Record<string, string>> {
	const authStore = await ensureFileAuthStore()
	const auth = await resolveCodexAuth(authStore, 'codex', globalThis.fetch, Date.now)
	const token = auth.kind === 'api' ? auth.apiKey : auth.accessToken
	const headers: Record<string, string> = {
		authorization: `Bearer ${token}`,
		originator: 'opencode',
		'User-Agent': buildCodexUserAgent(CODEX_DEFAULT_VERSION),
	}
	if (auth.kind === 'oauth' && auth.accountId) {
		headers['ChatGPT-Account-Id'] = auth.accountId
	}
	return headers
}

function openConnection(index: number, headers: Record<string, string>, timeoutMs: number): Promise<ConnectionResult> {
	const start = Date.now()
	return new Promise((resolve) => {
		let resolved = false
		const done = (result: ConnectionResult) => {
			if (resolved) return
			resolved = true
			clearTimeout(timer)
			resolve(result)
		}

		const timer = setTimeout(() => {
			try {
				ws.close()
			} catch {}
			done({ index, status: 'error', error: 'timeout', durationMs: Date.now() - start })
		}, timeoutMs)

		let ws: WebSocket
		try {
			ws = new WebSocket(WS_URL, { headers } as any)
		} catch (e) {
			done({
				index,
				status: 'error',
				error: `constructor: ${e instanceof Error ? e.message : String(e)}`,
				durationMs: Date.now() - start,
			})
			return
		}

		ws.onopen = () => {
			console.log(`  [${index}] ws open, sending request`)
			ws.send(JSON.stringify(MINIMAL_REQUEST))
		}

		ws.onmessage = (event) => {
			try {
				const parsed = JSON.parse(event.data as string)
				if (parsed.type === 'error') {
					console.log(`  [${index}] error event: ${parsed.error?.message ?? parsed.message ?? 'unknown'}`)
					ws.close()
					done({
						index,
						status: 'error',
						error: `api-error: ${parsed.error?.message ?? parsed.message ?? JSON.stringify(parsed)}`,
						durationMs: Date.now() - start,
					})
					return
				}
				if (
					parsed.type === 'response.completed' ||
					parsed.type === 'response.failed' ||
					parsed.type === 'response.incomplete'
				) {
					console.log(`  [${index}] ${parsed.type} (${Date.now() - start}ms)`)
					ws.close()
					done({ index, status: 'completed', firstEventType: parsed.type, durationMs: Date.now() - start })
					return
				}
			} catch {}
		}

		ws.onerror = (event: Event) => {
			const msg = 'message' in event && typeof event.message === 'string' ? event.message : 'unknown error'
			console.log(`  [${index}] ws error: ${msg}`)
			done({ index, status: 'error', error: msg, durationMs: Date.now() - start })
		}

		ws.onclose = (event) => {
			console.log(`  [${index}] ws close: code=${event.code}`)
			if (event.code !== 1000 && event.code !== 1005) {
				done({
					index,
					status: 'error',
					error: `close code ${event.code}: ${event.reason}`,
					durationMs: Date.now() - start,
				})
			}
		}
	})
}

async function probeConnectionLimit(headers: Record<string, string>, maxN: number): Promise<void> {
	console.log(`\n${'='.repeat(60)}`)
	console.log(`Probing concurrent WebSocket connection limit (max N=${maxN})`)
	console.log(`Endpoint: ${WS_URL}`)
	console.log(`${'='.repeat(60)}\n`)

	for (let n = 1; n <= maxN; n++) {
		// Open N connections simultaneously
		const promises = Array.from({ length: n }, (_, i) => openConnection(i, headers, 30000))

		const results = await Promise.all(promises)
		const succeeded = results.filter((r) => r.status === 'completed' || r.status === 'message-received')
		const failed = results.filter((r) => r.status === 'error')

		const avgDuration = Math.round(results.reduce((sum, r) => sum + r.durationMs, 0) / results.length)

		const failReasons = failed.map((r) => r.error ?? 'unknown')
		const uniqueReasons = [...new Set(failReasons)]

		console.log(
			`N=${String(n).padStart(2)}: ` +
				`${String(succeeded.length).padStart(2)} ok, ` +
				`${String(failed.length).padStart(2)} failed ` +
				`(avg ${avgDuration}ms)` +
				(uniqueReasons.length > 0 ? ` — ${uniqueReasons.join('; ')}` : ''),
		)

		// If we hit failures, run a couple more rounds to confirm the limit
		if (failed.length > 0 && n > 1) {
			console.log(`\n>>> First failures at N=${n}. Running 2 more rounds to confirm...`)
			for (let retry = 0; retry < 2; retry++) {
				await new Promise((r) => setTimeout(r, 3000)) // cooldown
				const retryPromises = Array.from({ length: n }, (_, i) => openConnection(i, headers, 30000))
				const retryResults = await Promise.all(retryPromises)
				const retryOk = retryResults.filter(
					(r) => r.status === 'completed' || r.status === 'message-received',
				).length
				const retryFail = retryResults.filter((r) => r.status === 'error').length
				console.log(`  Retry ${retry + 1}: ${retryOk} ok, ${retryFail} failed`)
			}
			console.log(`\n>>> Likely concurrent connection limit: ${n - 1}`)
			break
		}

		// Cooldown between rounds to let connections fully close server-side
		await new Promise((r) => setTimeout(r, 2000))
	}
}

async function probeConnectionRate(
	headers: Record<string, string>,
	concurrency: number,
	totalRequests: number,
	delayBetweenMs: number,
): Promise<void> {
	console.log(`\n${'='.repeat(60)}`)
	console.log(`Probing connection creation rate`)
	console.log(`Concurrency: ${concurrency}, Total: ${totalRequests}, Delay between: ${delayBetweenMs}ms`)
	console.log(`Endpoint: ${WS_URL}`)
	console.log(`${'='.repeat(60)}\n`)

	const results: ConnectionResult[] = []
	let inFlight = 0
	let nextIndex = 0
	const startTime = Date.now()

	const runOne = async (): Promise<void> => {
		const index = nextIndex++
		inFlight++
		console.log(`  [${index}] starting (in-flight: ${inFlight}, elapsed: ${Date.now() - startTime}ms)`)
		const result = await openConnection(index, headers, 30000)
		inFlight--
		results.push(result)
		console.log(
			`  [${index}] ${result.status} in ${result.durationMs}ms` +
				(result.error ? ` — ${result.error}` : '') +
				` (in-flight: ${inFlight})`,
		)
	}

	// Run sequentially with N concurrent lanes, like sub-agents would
	const lanes: Promise<void>[] = []
	for (let lane = 0; lane < concurrency; lane++) {
		const laneWork = async () => {
			const requestsPerLane = Math.ceil(totalRequests / concurrency)
			for (let i = 0; i < requestsPerLane && nextIndex < totalRequests; i++) {
				await runOne()
				if (delayBetweenMs > 0) await new Promise((r) => setTimeout(r, delayBetweenMs))
			}
		}
		lanes.push(laneWork())
	}
	await Promise.all(lanes)

	const succeeded = results.filter((r) => r.status === 'completed').length
	const failed = results.filter((r) => r.status === 'error').length
	const totalTime = Date.now() - startTime
	const connectionsPerSec = ((results.length / totalTime) * 1000).toFixed(1)

	console.log(`\n--- Summary ---`)
	console.log(`Total: ${results.length}, OK: ${succeeded}, Failed: ${failed}`)
	console.log(`Total time: ${totalTime}ms, Rate: ${connectionsPerSec} conn/sec`)

	if (failed > 0) {
		const firstFailIndex = results.findIndex((r) => r.status === 'error')
		console.log(`First failure at request #${results[firstFailIndex]!.index}`)
		const failReasons = [...new Set(results.filter((r) => r.status === 'error').map((r) => r.error))]
		console.log(`Failure reasons: ${failReasons.join('; ')}`)
	}
}

describe('WebSocket connection limit probe', () => {
	test('determine concurrent connection limit', async () => {
		const headers = await resolveHeaders()
		await probeConnectionLimit(headers, 15)
	}, 600_000)

	test('determine connection creation rate limit (4 lanes, no delay)', async () => {
		const headers = await resolveHeaders()
		// Simulate 4 sub-agents each making 5 sequential requests with no delay
		await probeConnectionRate(headers, 4, 20, 0)
	}, 600_000)

	test('determine connection creation rate limit (4 lanes, 500ms delay)', async () => {
		const headers = await resolveHeaders()
		// Same but with 500ms between requests per lane
		await probeConnectionRate(headers, 4, 20, 500)
	}, 600_000)
})
