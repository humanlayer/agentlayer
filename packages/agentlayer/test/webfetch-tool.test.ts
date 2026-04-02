import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createWebFetchTool } from '../src/tools/server/web-fetch'
import { makeToolContext } from './mocks'

// ─── Mock fetch helpers ───────────────────────────────────────────────────────

type MockFetchResponse = {
	ok: boolean
	status: number
	headers: Map<string, string>
	text(): Promise<string>
	arrayBuffer(): Promise<ArrayBuffer>
}

function mockFetchResponse(body: string, opts: { status?: number; contentType?: string } = {}): MockFetchResponse {
	const headers = new Map<string, string>()
	if (opts.contentType) headers.set('content-type', opts.contentType)
	return {
		ok: (opts.status ?? 200) >= 200 && (opts.status ?? 200) < 300,
		status: opts.status ?? 200,
		headers: {
			get: (name: string) => headers.get(name.toLowerCase()) ?? null,
		} as unknown as Map<string, string>,
		text: async () => body,
		arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
	}
}

let originalFetch: typeof globalThis.fetch
let mockFetchImpl: ((url: string | URL | Request, init?: RequestInit) => Promise<Response>) | null = null

beforeEach(() => {
	originalFetch = globalThis.fetch
	;(globalThis as any).fetch = async (url: string | URL | Request, init?: RequestInit) => {
		if (mockFetchImpl) {
			return mockFetchImpl(url, init) as unknown as Response
		}
		throw new Error('fetch called without a mock implementation')
	}
})

afterEach(() => {
	;(globalThis as any).fetch = originalFetch
	mockFetchImpl = null
})

// ─── createWebFetchTool ─────────────────────────────────────────────────

describe('createWebFetchTool', () => {
	test('tool has correct name', () => {
		const tool = createWebFetchTool()
		expect(tool.name).toBe('webfetch')
	})

	test('tool has non-empty description', () => {
		const tool = createWebFetchTool()
		expect(tool.description.length).toBeGreaterThan(0)
	})

	// ── HTML to markdown conversion ──

	test('HTML response with format=markdown converts to markdown', async () => {
		mockFetchImpl = async () =>
			mockFetchResponse('<html><body><h1>Hello</h1><p>World</p></body></html>', {
				contentType: 'text/html',
			}) as unknown as Response

		const tool = createWebFetchTool()
		const result = await tool.execute(
			{ url: 'https://example.com', format: 'markdown', timeout: 30_000 },
			makeToolContext(),
		)
		expect(typeof result).toBe('string')
		const output = result as string
		expect(output).toContain('Hello')
		expect(output).toContain('World')
		// Should use ATX heading style (# Hello)
		expect(output).toMatch(/^#\s+Hello/m)
	})

	test('HTML response with format=html returns raw HTML', async () => {
		const rawHtml = '<html><body><h1>Raw</h1></body></html>'
		mockFetchImpl = async () => mockFetchResponse(rawHtml, { contentType: 'text/html' }) as unknown as Response

		const tool = createWebFetchTool()
		const result = await tool.execute(
			{ url: 'https://example.com', format: 'html', timeout: 30_000 },
			makeToolContext(),
		)
		expect(result).toBe(rawHtml)
	})

	test('HTML response with format=text strips HTML tags', async () => {
		mockFetchImpl = async () =>
			mockFetchResponse(
				'<html><body><h1>Title</h1><p>Plain text content.</p><script>alert(1)</script></body></html>',
				{ contentType: 'text/html' },
			) as unknown as Response

		const tool = createWebFetchTool()
		const result = await tool.execute(
			{ url: 'https://example.com', format: 'text', timeout: 30_000 },
			makeToolContext(),
		)
		const output = result as string
		expect(output).toContain('Title')
		expect(output).toContain('Plain text content.')
		expect(output).not.toContain('<h1>')
		expect(output).not.toContain('<script>')
		expect(output).not.toContain('alert(1)')
	})

	// ── Non-HTML content types ──

	test('plain text response returned as-is for markdown format', async () => {
		const plainText = 'This is plain text\nNo HTML here'
		mockFetchImpl = async () => mockFetchResponse(plainText, { contentType: 'text/plain' }) as unknown as Response

		const tool = createWebFetchTool()
		const result = await tool.execute(
			{ url: 'https://example.com/text.txt', format: 'markdown', timeout: 30_000 },
			makeToolContext(),
		)
		expect(result).toBe(plainText)
	})

	test('JSON response returned as-is for html format', async () => {
		const json = '{"key":"value"}'
		mockFetchImpl = async () => mockFetchResponse(json, { contentType: 'application/json' }) as unknown as Response

		const tool = createWebFetchTool()
		const result = await tool.execute(
			{ url: 'https://api.example.com/data', format: 'html', timeout: 30_000 },
			makeToolContext(),
		)
		expect(result).toBe(json)
	})

	// ── Image handling ──

	test('image MIME type returns base64 data URI', async () => {
		const imageBytes = new Uint8Array([0xff, 0xd8, 0xff]) // fake JPEG header
		mockFetchImpl = async () => {
			const headers = new Map<string, string>()
			headers.set('content-type', 'image/jpeg')
			return {
				ok: true,
				status: 200,
				headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
				text: async () => new TextDecoder().decode(imageBytes),
				arrayBuffer: async () => imageBytes.buffer as ArrayBuffer,
			} as unknown as Response
		}

		const tool = createWebFetchTool()
		const result = await tool.execute(
			{ url: 'https://example.com/image.jpg', format: 'markdown', timeout: 30_000 },
			makeToolContext(),
		)
		const output = result as string
		expect(output).toMatch(/^data:image\/jpeg;base64,/)
	})

	test('image content-type is case-insensitive', async () => {
		const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]) // fake PNG header
		mockFetchImpl = async () => {
			const headers = new Map<string, string>()
			headers.set('content-type', 'Image/PNG') // mixed case
			return {
				ok: true,
				status: 200,
				headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
				text: async () => '',
				arrayBuffer: async () => imageBytes.buffer as ArrayBuffer,
			} as unknown as Response
		}

		const tool = createWebFetchTool()
		const result = await tool.execute(
			{ url: 'https://example.com/image.png', format: 'markdown', timeout: 30_000 },
			makeToolContext(),
		)
		const output = result as string
		expect(output).toMatch(/^data:image\/png;base64,/)
	})

	test('SVG image treated as text (not base64)', async () => {
		const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="10"/></svg>'
		mockFetchImpl = async () => mockFetchResponse(svg, { contentType: 'image/svg+xml' }) as unknown as Response

		const tool = createWebFetchTool()
		const result = await tool.execute(
			{ url: 'https://example.com/icon.svg', format: 'html', timeout: 30_000 },
			makeToolContext(),
		)
		// SVG should not be base64-encoded — returned as text
		expect(result).not.toMatch(/^data:/)
		expect(result).toContain('svg')
	})

	// ── Error handling ──

	test('throws on non-http URL', async () => {
		const tool = createWebFetchTool()
		await expect(
			tool.execute({ url: 'ftp://example.com/file', format: 'markdown', timeout: 30_000 }, makeToolContext()),
		).rejects.toThrow('URL must start with http://')
	})

	test('throws on HTTP 404 response', async () => {
		mockFetchImpl = async () =>
			mockFetchResponse('Not Found', { status: 404, contentType: 'text/plain' }) as unknown as Response

		const tool = createWebFetchTool()
		await expect(
			tool.execute(
				{ url: 'https://example.com/missing', format: 'markdown', timeout: 30_000 },
				makeToolContext(),
			),
		).rejects.toThrow('Request failed with status code: 404')
	})

	test('throws on HTTP 500 response', async () => {
		mockFetchImpl = async () =>
			mockFetchResponse('Server Error', { status: 500, contentType: 'text/plain' }) as unknown as Response

		const tool = createWebFetchTool()
		await expect(
			tool.execute({ url: 'https://example.com/', format: 'markdown', timeout: 30_000 }, makeToolContext()),
		).rejects.toThrow('Request failed with status code: 500')
	})

	// ── Markdown default format ──

	test('default format is markdown (HTML response converted)', async () => {
		mockFetchImpl = async () =>
			mockFetchResponse('<html><body><h2>Default Format</h2></body></html>', {
				contentType: 'text/html',
			}) as unknown as Response

		const tool = createWebFetchTool()
		// Use parsed defaults — webFetchInput defaults format to 'markdown' and timeout to 30_000
		const result = await tool.execute(
			{ url: 'https://example.com', format: 'markdown', timeout: 30_000 },
			makeToolContext(),
		)
		const output = result as string
		// ATX heading for h2 → ## Default Format
		expect(output).toMatch(/^##\s+Default Format/m)
	})

	// ── Script/style removal in markdown ──

	test('script and style tags are removed in markdown output', async () => {
		mockFetchImpl = async () =>
			mockFetchResponse(
				'<html><head><style>.foo{color:red}</style></head><body><script>var x=1</script><p>Content</p></body></html>',
				{ contentType: 'text/html' },
			) as unknown as Response

		const tool = createWebFetchTool()
		const result = await tool.execute(
			{ url: 'https://example.com', format: 'markdown', timeout: 30_000 },
			makeToolContext(),
		)
		const output = result as string
		expect(output).not.toContain('.foo')
		expect(output).not.toContain('var x=1')
		expect(output).toContain('Content')
	})
})
