import type { CodeSearchInput } from '../interfaces/code-search'
import { CodeSearchTool } from '../interfaces/code-search'
import DESCRIPTION from './code-search.txt'

const EXA_CONTEXT_URL = 'https://api.exa.ai/context'
const CONTEXT7_BASE_URL = 'https://context7.com'
const DEFAULT_TIMEOUT_MS = 30_000

export interface CodeSearchOptions {
	exaApiKey?: string
	context7ApiKey?: string
	timeoutMs?: number
}

/**
 * Fetch code documentation from the Exa context API.
 */
async function fetchExa(input: CodeSearchInput, apiKey: string, timeoutMs: number): Promise<string | null> {
	try {
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
			return null
		}

		const data = (await response.json()) as { response?: string }
		return data.response ?? null
	} catch {
		return null
	}
}

/**
 * Fetch code documentation from the Context7 API (two-step: search then context).
 */
async function fetchContext7(input: CodeSearchInput, apiKey: string, timeoutMs: number): Promise<string | null> {
	try {
		// Step 1: search for the library
		const searchParams = new URLSearchParams({ query: input.query, libraryName: input.packageName })
		const searchResponse = await fetch(`${CONTEXT7_BASE_URL}/api/v2/libs/search?${searchParams}`, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(timeoutMs),
		})

		if (!searchResponse.ok) {
			return null
		}

		const searchData = (await searchResponse.json()) as {
			results?: Array<{ id: string; title: string; trustScore?: number }>
		}
		const libraries = searchData.results ?? []

		if (libraries.length === 0) {
			return null
		}

		// Pick the library with the highest trustScore (first result if no score)
		const best = libraries.reduce((a, b) => ((b.trustScore ?? 0) > (a.trustScore ?? 0) ? b : a))

		// Step 2: fetch context for the selected library
		const contextParams = new URLSearchParams({ query: input.query, libraryId: best.id })
		const contextResponse = await fetch(`${CONTEXT7_BASE_URL}/api/v2/context?${contextParams}`, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(timeoutMs),
		})

		if (!contextResponse.ok) {
			return null
		}

		return contextResponse.text()
	} catch {
		return null
	}
}

export function createCodeSearchTool(opts: CodeSearchOptions) {
	if (!opts.exaApiKey && !opts.context7ApiKey) {
		throw new Error('At least one API key (exaApiKey or context7ApiKey) is required')
	}

	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

	return CodeSearchTool.define(
		async (input: CodeSearchInput): Promise<string> => {
			const [exaResult, c7Result] = await Promise.all([
				opts.exaApiKey ? fetchExa(input, opts.exaApiKey, timeoutMs) : Promise.resolve(null),
				opts.context7ApiKey ? fetchContext7(input, opts.context7ApiKey, timeoutMs) : Promise.resolve(null),
			])

			const parts: string[] = []
			if (c7Result) {
				parts.push(`## Context7 Documentation\n\n${c7Result}`)
			}
			if (exaResult) {
				parts.push(`## Exa Search Results\n\n${exaResult}`)
			}

			if (parts.length === 0) {
				return `No documentation found for "${input.packageName}" with query: ${input.query}`
			}

			return parts.join('\n\n---\n\n')
		},
		{ description: DESCRIPTION },
	)
}
