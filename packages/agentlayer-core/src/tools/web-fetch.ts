import TurndownService from 'turndown'
import { WebFetchTool } from '../interfaces/web-fetch'
import { WEB_FETCH_DESCRIPTION } from '../prompts'

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024 // 5MB
const MAX_TIMEOUT_MS = 120_000

/**
 * Strip HTML tags from a string to produce plain text.
 * Removes script/style content and collapses whitespace.
 */
function stripHtmlTags(html: string): string {
	// Remove script and style blocks (including content)
	const text = html
		.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
		.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
		// Remove all remaining HTML tags
		.replace(/<[^>]+>/g, '')
		// Decode common HTML entities
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, ' ')
		// Collapse multiple blank lines
		.replace(/\n{3,}/g, '\n\n')
		.trim()
	return text
}

export function createWebFetchTool() {
	const turndown = new TurndownService({
		headingStyle: 'atx',
		codeBlockStyle: 'fenced',
	})
	// Remove elements that don't contribute readable content
	turndown.remove(['script', 'style', 'meta', 'link', 'noscript', 'iframe'])

	return WebFetchTool.define(
		async (input) => {
			if (!input.url.startsWith('http://') && !input.url.startsWith('https://')) {
				throw new Error('URL must start with http:// or https://')
			}

			const timeoutMs = Math.min(input.timeout, MAX_TIMEOUT_MS)

			let response: Response
			try {
				response = await fetch(input.url, {
					signal: AbortSignal.timeout(timeoutMs),
					headers: {
						'User-Agent':
							'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
					},
				})
			} catch (err: unknown) {
				const e = err as Error
				if (e.name === 'TimeoutError' || e.name === 'AbortError') {
					throw new Error(`Request timed out after ${timeoutMs}ms`)
				}
				throw err
			}

			if (!response.ok) {
				throw new Error(`Request failed with status code: ${response.status}`)
			}

			// Check content-length header before reading body
			const contentLength = response.headers.get('content-length')
			if (contentLength && Number.parseInt(contentLength, 10) > MAX_RESPONSE_SIZE) {
				throw new Error('Response too large (exceeds 5MB limit)')
			}

			const contentType = (response.headers.get('content-type') ?? '').toLowerCase()

			// For images (excluding SVG), return a base64 data URI
			if (contentType.startsWith('image/') && !contentType.includes('svg')) {
				const bytes = await response.arrayBuffer()
				if (bytes.byteLength > MAX_RESPONSE_SIZE) {
					throw new Error('Response too large (exceeds 5MB limit)')
				}
				const base64 = Buffer.from(bytes).toString('base64')
				const mimeType = contentType.split(';')[0]?.trim() ?? 'image/unknown'
				return `data:${mimeType};base64,${base64}`
			}

			const body = await response.text()

			if (body.length > MAX_RESPONSE_SIZE) {
				throw new Error('Response too large (exceeds 5MB limit)')
			}

			const isHtml =
				contentType.includes('text/html') ||
				body.trimStart().startsWith('<!') ||
				body.trimStart().toLowerCase().startsWith('<html')

			if (input.format === 'html') {
				return body
			}

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
		{ description: WEB_FETCH_DESCRIPTION },
	)
}
