import type { WebSearchInput, WebSearchResult } from '@humanlayer/agentlayer-core'
import { WebSearchTool } from '@humanlayer/agentlayer-core'
import type { Bash } from 'just-bash'
import DESCRIPTION from './web-search.txt'

const DEFAULT_TIMEOUT_SEC = 25

export interface JustBashWebSearchOptions {
	exaApiKey: string
	timeoutSec?: number
}

export function createWebSearchTool(bash: Bash, opts: JustBashWebSearchOptions) {
	const timeoutSec = opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC

	return WebSearchTool.define(
		async (input: WebSearchInput): Promise<WebSearchResult> => {
			const payload = JSON.stringify({
				query: input.query,
				numResults: input.numResults,
				contents: { text: { maxCharacters: 500 } },
			})

			// Escape single quotes in payload for shell safety
			const escapedPayload = payload.replace(/'/g, "'\\''")

			const result = await bash.exec(
				`curl -s --max-time ${timeoutSec} ` +
					`-H "Content-Type: application/json" ` +
					`-H "x-api-key: ${opts.exaApiKey}" ` +
					`-d '${escapedPayload}' ` +
					`https://api.exa.ai/search`,
			)

			if (result.exitCode !== 0) {
				if (result.exitCode === 28) {
					throw new Error('Search request timed out')
				}
				throw new Error(`curl failed (exit ${result.exitCode}): ${result.stderr}`)
			}

			let data: { results?: Array<{ title?: string; url?: string; text?: string; snippet?: string }> }
			try {
				data = JSON.parse(result.stdout)
			} catch {
				throw new Error(`Failed to parse search response: ${result.stdout.slice(0, 200)}`)
			}

			const results = (data.results ?? []).map((r) => ({
				title: r.title ?? '',
				url: r.url ?? '',
				snippet: r.text ?? r.snippet ?? '',
			}))

			return { results }
		},
		{ description: DESCRIPTION },
	)
}
