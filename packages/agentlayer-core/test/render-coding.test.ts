import { afterEach, describe, expect, test } from 'bun:test'
import { stripANSI } from 'bun'
import type { ModelMessage } from 'ai'
import { CodingRenderer } from '../src/render-coding'

const originalWrite = process.stdout.write.bind(process.stdout)

function captureStdout(run: () => void): string {
	let output = ''
	process.stdout.write = ((chunk: string | Uint8Array) => {
		output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
		return true
	}) as typeof process.stdout.write

	try {
		run()
		return stripANSI(output)
	} finally {
		process.stdout.write = originalWrite as typeof process.stdout.write
	}
}

afterEach(() => {
	process.stdout.write = originalWrite as typeof process.stdout.write
})

describe('CodingRenderer', () => {
	test('verboseToolResults shows full multi-line tool output', () => {
		const renderer = new CodingRenderer({
			showResponse: true,
			toolLabelStyle: 'compact',
			verboseToolResults: true,
		})

		const toolMessage: ModelMessage = {
			role: 'tool',
			content: [
				{
					type: 'tool-result',
					toolCallId: 'call-1',
					toolName: 'read',
					output: { type: 'text', value: 'line 1\nline 2\nline 3' },
				},
			],
		}

		const rendered = captureStdout(() => {
			renderer.renderMessage(toolMessage)
		})

		expect(rendered).toContain('[Response] line 1\n  line 2\n  line 3')
	})

	test('non-verbose renderer keeps tool output compact and truncated', () => {
		const renderer = new CodingRenderer({
			showResponse: true,
			toolLabelStyle: 'compact',
			verboseToolResults: false,
		})

		const longOutput = Array.from({ length: 80 }, (_, index) => `segment-${index}`).join(' ')
		const toolMessage: ModelMessage = {
			role: 'tool',
			content: [
				{
					type: 'tool-result',
					toolCallId: 'call-2',
					toolName: 'bash',
					output: { type: 'text', value: longOutput },
				},
			],
		}

		const rendered = captureStdout(() => {
			renderer.renderMessage(toolMessage)
		})

		expect(rendered).toContain('[Response]')
		expect(rendered).toContain('segment-0')
		expect(rendered).toContain('…')
	})
})
