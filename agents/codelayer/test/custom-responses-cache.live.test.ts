import { describe, expect, test } from 'bun:test'
import { startState, type AgentEvent, type AgentState } from '@humanlayer/agentlayer-core'
import { createCodelayerAgent, resolveModel } from '../src'

const enabled = process.env.CODELAYER_LIVE_CACHE_TEST === '1' && Boolean(process.env.OPENAI_API_KEY)

const liveBaseUrl = 'https://api.openai.com/v1'
const liveApiKey = process.env.OPENAI_API_KEY
const liveModel = process.env.OPENAI_RESPONSES_TEST_MODEL ?? 'gpt-5.6'

const stablePrefix = Array.from({ length: 1_300 }, () => 'cacheable').join(' ')

type Usage = Extract<AgentEvent, { type: 'tokenUsage' }>['usage']['usage']
type RawUsage = {
	input_tokens?: number
	input_tokens_details?: Record<string, number>
	output_tokens?: number
	output_tokens_details?: Record<string, number>
}

function responseUsages(body: string): RawUsage[] {
	const usages: RawUsage[] = []
	for (const line of body.split('\n')) {
		if (!line.startsWith('data: ') || line === 'data: [DONE]') continue
		try {
			const event = JSON.parse(line.slice(6)) as { type?: string; response?: { usage?: RawUsage } }
			if (event.type?.startsWith('response.') && event.response?.usage) usages.push(event.response.usage)
		} catch {
			// Ignore non-JSON SSE data.
		}
	}
	return usages
}

function metric(label: string, usage: Usage, elapsedMs: number) {
	return {
		label,
		input: usage.inputTokens,
		noncached: Math.max(0, usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens),
		cacheRead: usage.cacheReadTokens,
		cacheWrite: usage.cacheWriteTokens,
		output: usage.outputTokens,
		reasoning: usage.reasoningTokens,
		elapsedMs,
	}
}

async function runAndReport(
	agent: Awaited<ReturnType<typeof createCodelayerAgent>>,
	state: AgentState,
	promptCacheKey: string,
	label: string,
) {
	const startedAt = performance.now()
	const run = agent.run({ state, promptCacheKey })
	const usageEvents: Extract<AgentEvent, { type: 'tokenUsage' }>[] = []
	for await (const event of run) {
		if (event.type === 'tokenUsage') {
			usageEvents.push(event)
			console.log(JSON.stringify(metric(`${label}.${usageEvents.length}`, event.usage.usage, Math.round(performance.now() - startedAt))))
		}
	}
	const result = await run.result
	console.log(JSON.stringify(metric(`${label}.total`, result.tokenUsage.totals, Math.round(performance.now() - startedAt))))
	return { result, usageEvents }
}

describe.skipIf(!enabled)('public OpenAI custom Responses prompt caching', () => {
	// Parent follow-ups give OpenAI several low-cost chances to expose a cache hit. A live child
	// adds a second model decision and has proved too variable; unit tests cover its exact key derivation.
	test(
		'reuses a stable cache scope across real Agent runs',
		async () => {
			const originalFetch = globalThis.fetch
			const rawUsages: RawUsage[] = []
			const previous = {
				baseUrl: process.env.CODELAYER_CODEX_BASE_URL,
				apiKey: process.env.CODELAYER_CODEX_API_KEY,
				apiKeyHeader: process.env.CODELAYER_CODEX_API_KEY_HEADER,
				model: process.env.CODELAYER_CODEX_MODEL,
			}
			process.env.CODELAYER_CODEX_BASE_URL = liveBaseUrl
			process.env.CODELAYER_CODEX_API_KEY = liveApiKey!
			delete process.env.CODELAYER_CODEX_API_KEY_HEADER
			process.env.CODELAYER_CODEX_MODEL = liveModel
			globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
				const response = await originalFetch(input, init)
				const usages = responseUsages(await response.clone().text())
				for (const usage of usages) {
					rawUsages.push(usage)
					console.log(JSON.stringify({ label: 'raw-wire-usage', ...usage }))
				}
				return response
			}, { preconnect: originalFetch.preconnect })

			try {
				const model = await resolveModel('codex', liveModel)
				const agent = await createCodelayerAgent({
					model,
					cwd: process.cwd(),
					systemPromptAdditions: [`Keep this fixed cache test prefix unchanged:\n${stablePrefix}`],
					providerOptionOverrides: { codex: { reasoningEffort: 'low' } },
					tools: {
						bash: false,
						read: false,
						write: false,
						edit: false,
						applyPatch: false,
						list: false,
						grep: false,
						glob: false,
						webFetch: false,
					},
				})
				const promptCacheKey = crypto.randomUUID()
				const first = await runAndReport(
					agent,
					startState([{ role: 'user', content: 'Reply with only: warm' }]),
					promptCacheKey,
					'warm',
				)
				const baseFollowUpState: AgentState = {
					...first.result.state,
					messages: [...first.result.state.messages, { role: 'user', content: 'Reply with only: follow-up' }],
				}
				const followUps = []
				let followUpState = baseFollowUpState
				for (let attempt = 1; attempt <= 3; attempt++) {
					const followUp = await runAndReport(agent, followUpState, promptCacheKey, `stable-${attempt}`)
					followUps.push(followUp)
					followUpState = {
						...followUp.result.state,
						messages: [...followUp.result.state.messages, { role: 'user', content: `Reply with only: ${attempt}` }],
					}
				}
				// Keep this control observational. The API also hashes the prompt prefix, so a changed key
				// cannot prove a key-only miss. Stable follow-ups above prove positive cache reads.
				await runAndReport(agent, baseFollowUpState, crypto.randomUUID(), 'changed-key-control')

				expect(first.usageEvents[0]?.usage.usage.inputTokens ?? 0).toBeGreaterThan(1_024)
				expect(
					followUps.some((followUp) =>
						followUp.usageEvents.some((event) => event.usage.usage.cacheReadTokens > 0),
					),
				).toBe(true)
				expect(
					[first, ...followUps].some((run) =>
						run.usageEvents.some((event) => event.usage.usage.cacheWriteTokens > 0),
					),
				).toBe(true)
				expect(
					[first, ...followUps].some((run) => run.result.tokenUsage.totals.cacheWriteTokens > 0),
				).toBe(true)
				expect(rawUsages.length).toBeGreaterThan(0)
			} finally {
				globalThis.fetch = originalFetch
				for (const [name, value] of [
					['CODELAYER_CODEX_BASE_URL', previous.baseUrl],
					['CODELAYER_CODEX_API_KEY', previous.apiKey],
					['CODELAYER_CODEX_API_KEY_HEADER', previous.apiKeyHeader],
					['CODELAYER_CODEX_MODEL', previous.model],
				] as const) {
					if (value === undefined) delete process.env[name]
					else process.env[name] = value
				}
			}
		},
		180_000,
	)
})
