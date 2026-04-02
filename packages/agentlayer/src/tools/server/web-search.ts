import type { WebSearchInput, WebSearchResult } from '../interfaces/web-search'
import { WebSearchTool } from '../interfaces/web-search'
import DESCRIPTION from './web-search.txt'

const EXA_API_URL = 'https://api.exa.ai/search'
const DEFAULT_TIMEOUT_MS = 25_000

export interface WebSearchOptions {
	exaApiKey: string
	timeoutMs?: number
}

/**
 * Fetch web search results from the Exa search API.
 */
async function fetchExaSearch(
	query: string,
	numResults: number,
	apiKey: string,
	timeoutMs: number,
): Promise<WebSearchResult> {
	const response = await fetch(EXA_API_URL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'x-api-key': apiKey,
		},
		body: JSON.stringify({
			query,
			numResults,
			contents: {
				text: { maxCharacters: 500 },
			},
		}),
		signal: AbortSignal.timeout(timeoutMs),
	})

	if (!response.ok) {
		const text = await response.text().catch(() => '')
		throw new Error(`Exa search API error ${response.status}: ${text}`)
	}

	const data = (await response.json()) as {
		results?: Array<{
			title?: string
			url?: string
			text?: string
			snippet?: string
		}>
	}

	const results = (data.results ?? []).map((r) => ({
		title: r.title ?? '',
		url: r.url ?? '',
		snippet: r.text ?? r.snippet ?? '',
	}))

	return { results }
}

export function createWebSearchTool(opts: WebSearchOptions) {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

	const description = DESCRIPTION.replace('{{year}}', new Date().getFullYear().toString())

	return WebSearchTool.define(
		async (input: WebSearchInput): Promise<WebSearchResult> => {
			let result: WebSearchResult
			try {
				result = await fetchExaSearch(input.query, input.numResults, opts.exaApiKey, timeoutMs)
			} catch (err: unknown) {
				const e = err as Error
				if (e.name === 'TimeoutError' || e.name === 'AbortError') {
					throw new Error('Search request timed out')
				}
				throw err
			}
			return result
		},
		{ description },
	)
}
