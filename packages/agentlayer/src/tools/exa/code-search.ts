import type { CodeSearchInput } from '../interfaces/code-search'
import { CodeSearchTool } from '../interfaces/code-search'

const EXA_CONTEXT_URL = 'https://api.exa.ai/context'
const DEFAULT_TIMEOUT_MS = 30_000

export interface ExaCodeSearchOptions {
	exaApiKey: string
	timeoutMs?: number
}

async function fetchExa(input: CodeSearchInput, apiKey: string, timeoutMs: number): Promise<string> {
	const query = `${input.query} -- for ${input.packageName} in ${input.language}`
	const response = await fetch(EXA_CONTEXT_URL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'x-api-key': apiKey,
		},
		body: JSON.stringify({ query, tokensNum: 5000 }),
		signal: AbortSignal.timeout(timeoutMs),
	})

	if (!response.ok) {
		const text = await response.text().catch(() => '')
		throw new Error(`Exa context API error ${response.status}: ${text}`)
	}

	const data = (await response.json()) as { response?: string }
	return data.response ?? `No documentation found for "${input.packageName}"`
}

export function createExaCodeSearchTool(opts: ExaCodeSearchOptions) {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

	return CodeSearchTool.define(async (input: CodeSearchInput): Promise<string> => {
		return fetchExa(input, opts.exaApiKey, timeoutMs)
	})
}
