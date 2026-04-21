import { WebFetchTool } from '@humanlayer/agentlayer-core'
import type { Bash } from 'just-bash'
import TurndownService from 'turndown'

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024 // 5MB in bytes
const MAX_TIMEOUT_MS = 120_000

/**
 * Strip HTML tags from a string to produce plain text.
 */
function stripHtmlTags(html: string): string {
	return html
		.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
		.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
		.replace(/<[^>]+>/g, '')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, ' ')
		.replace(/\n{3,}/g, '\n\n')
		.trim()
}

export function createWebFetchTool(bash: Bash) {
	const turndown = new TurndownService({
		headingStyle: 'atx',
		codeBlockStyle: 'fenced',
	})
	turndown.remove(['script', 'style', 'meta', 'link', 'noscript', 'iframe'])

	return WebFetchTool.define(
		async (input) => {
			if (!input.url.startsWith('http://') && !input.url.startsWith('https://')) {
				throw new Error('URL must start with http:// or https://')
			}

			const timeoutSec = Math.min(input.timeout, MAX_TIMEOUT_MS) / 1000
			const maxSizeBytes = MAX_RESPONSE_SIZE

			// curl flags:
			// -s: silent, -L: follow redirects
			// --max-filesize: reject oversized responses
			// --max-time: timeout
			// -A: User-Agent
			// -w '\n%{http_code}': append status code on last line
			const result = await bash.exec(
				`curl -sL --max-filesize ${maxSizeBytes} --max-time ${timeoutSec} ` +
					`-A "Mozilla/5.0 (compatible; agent/1.0)" ` +
					`-w '\\n%{http_code}' "${input.url}"`,
			)

			if (result.exitCode !== 0) {
				// curl exit code 28 = timeout, 63 = file too large
				if (result.exitCode === 28) {
					throw new Error(`Request timed out after ${input.timeout}ms`)
				}
				if (result.exitCode === 63) {
					throw new Error('Response too large (exceeds 5MB limit)')
				}
				throw new Error(`curl failed (exit ${result.exitCode}): ${result.stderr}`)
			}

			// Split off the status code appended by -w
			const lines = result.stdout.split('\n')
			const statusLine = lines[lines.length - 1]?.trim() ?? ''
			const statusCode = Number.parseInt(statusLine, 10)
			const body = lines.slice(0, -1).join('\n')

			if (!Number.isNaN(statusCode) && statusCode >= 400) {
				throw new Error(`Request failed with status code: ${statusCode}`)
			}

			if (input.format === 'html') {
				return body
			}

			const isHtml = body.trimStart().startsWith('<!') || body.trimStart().toLowerCase().startsWith('<html')

			if (input.format === 'text') {
				if (isHtml) {
					return stripHtmlTags(body)
				}
				return body
			}

			// format === 'markdown' (default)
			if (isHtml) {
				return turndown.turndown(body)
			}
			return body
		},
		{ description: DESCRIPTION },
	)
}
