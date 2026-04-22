import type { CodeSearchInput } from '@humanlayer/agentlayer-core/interfaces'
import { CodeSearchTool } from '@humanlayer/agentlayer-core/interfaces'
import { CODE_SEARCH_DESCRIPTION } from '@humanlayer/agentlayer-core/prompts'
import type { Bash } from 'just-bash'

const DEFAULT_TIMEOUT_SEC = 30
const CONTEXT7_BASE_URL = 'https://context7.com'

export interface JustBashCodeSearchOptions {
	exaApiKey?: string
	context7ApiKey?: string
	timeoutSec?: number
}

async function fetchExaViaBash(
	bash: Bash,
	input: CodeSearchInput,
	apiKey: string,
	timeoutSec: number,
): Promise<string | null> {
	try {
		const query = `${input.query} -- for ${input.packageName} in ${input.language}`
		const payload = JSON.stringify({ query, tokensNum: 5000 })
		const escapedPayload = payload.replace(/'/g, "'\\''")

		const result = await bash.exec(
			`curl -s --max-time ${timeoutSec} ` +
				`-H "Content-Type: application/json" ` +
				`-H "x-api-key: ${apiKey}" ` +
				`-d '${escapedPayload}' ` +
				`https://api.exa.ai/context`,
		)

		if (result.exitCode !== 0) return null

		const data = JSON.parse(result.stdout) as { response?: string }
		return data.response ?? null
	} catch {
		return null
	}
}

async function fetchContext7ViaBash(
	bash: Bash,
	input: CodeSearchInput,
	apiKey: string,
	timeoutSec: number,
): Promise<string | null> {
	try {
		// Step 1: search for the library
		const searchQuery = encodeURIComponent(input.query)
		const libName = encodeURIComponent(input.packageName)

		const searchResult = await bash.exec(
			`curl -s --max-time ${timeoutSec} ` +
				`-H "Authorization: Bearer ${apiKey}" ` +
				`"${CONTEXT7_BASE_URL}/api/v2/libs/search?query=${searchQuery}&libraryName=${libName}"`,
		)

		if (searchResult.exitCode !== 0) return null

		const searchData = JSON.parse(searchResult.stdout) as {
			results?: Array<{ id: string; title: string; trustScore?: number }>
		}
		const libraries = searchData.results ?? []
		if (libraries.length === 0) return null

		const best = libraries.reduce((a, b) => ((b.trustScore ?? 0) > (a.trustScore ?? 0) ? b : a))

		// Step 2: fetch context for the selected library
		const contextQuery = encodeURIComponent(input.query)
		const libId = encodeURIComponent(best.id)

		const contextResult = await bash.exec(
			`curl -s --max-time ${timeoutSec} ` +
				`-H "Authorization: Bearer ${apiKey}" ` +
				`"${CONTEXT7_BASE_URL}/api/v2/context?query=${contextQuery}&libraryId=${libId}"`,
		)

		if (contextResult.exitCode !== 0) return null
		return contextResult.stdout
	} catch {
		return null
	}
}

export function createCodeSearchTool(bash: Bash, opts: JustBashCodeSearchOptions) {
	if (!opts.exaApiKey && !opts.context7ApiKey) {
		throw new Error('At least one API key (exaApiKey or context7ApiKey) is required')
	}

	const timeoutSec = opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC

	return CodeSearchTool.define(
		async (input: CodeSearchInput): Promise<string> => {
			const [exaResult, c7Result] = await Promise.all([
				opts.exaApiKey ? fetchExaViaBash(bash, input, opts.exaApiKey, timeoutSec) : Promise.resolve(null),
				opts.context7ApiKey
					? fetchContext7ViaBash(bash, input, opts.context7ApiKey, timeoutSec)
					: Promise.resolve(null),
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
		{ description: CODE_SEARCH_DESCRIPTION },
	)
}
