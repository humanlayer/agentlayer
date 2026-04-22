import type { WebSearchInput, WebSearchResult } from '@humanlayer/agentlayer-core'
import { WebSearchTool } from '@humanlayer/agentlayer-core'
import { WEB_SEARCH_DESCRIPTION } from '@humanlayer/agentlayer-core/prompts'

const DEFAULT_ENDPOINT = 'https://api.exa.ai/search'
const DEFAULT_TIMEOUT_MS = 25_000

export interface WebSearchToolOptions {
	exaApiKey: string
	endpoint?: string
	timeoutMs?: number
}

export function createWebSearchTool(opts: WebSearchToolOptions) {
	const endpoint = opts.endpoint ?? DEFAULT_ENDPOINT
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

	return WebSearchTool.define(
		async (input: WebSearchInput): Promise<WebSearchResult> => {
			const response = await fetch(endpoint, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'x-api-key': opts.exaApiKey,
				},
				body: JSON.stringify({
					query: input.query,
					numResults: input.numResults,
					contents: { text: { maxCharacters: 500 } },
				}),
				signal: AbortSignal.timeout(timeoutMs),
			})

			if (!response.ok) {
				throw new Error(`Search request failed with status code: ${response.status}`)
			}

			const data = (await response.json()) as {
				results?: Array<{ title?: string; url?: string; text?: string; snippet?: string }>
			}

			return {
				results: (data.results ?? []).map((result) => ({
					title: result.title ?? '',
					url: result.url ?? '',
					snippet: result.text ?? result.snippet ?? '',
				})),
			}
		},
		{ description: WEB_SEARCH_DESCRIPTION },
	)
}
