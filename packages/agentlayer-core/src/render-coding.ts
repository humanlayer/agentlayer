import type { ModelMessage } from 'ai'
import * as color from './color'
import { Renderer } from './render'

export interface CodingRendererOptions {
	showResponse?: boolean
	toolLabelStyle?: 'bracket' | 'compact'
	verboseToolResults?: boolean
}

const TOOL_COLORS: Record<string, (text: string) => string> = {
	read: color.blue,
	grep: color.blue,
	glob: color.blue,
	list: color.blue,
	write: color.yellow,
	edit: color.orange,
	multiedit: color.orange,
	'apply-patch': color.orange,
	apply_patch: color.orange,
	bash: color.red,
	webfetch: color.teal,
	websearch: color.teal,
	'web-fetch': color.teal,
	'web-search': color.teal,
	web_fetch: color.teal,
	web_search: color.teal,
	structured_output: color.green,
	done: color.green,
	todowrite: color.amber,
	todo_write: color.amber,
	agent: color.fuchsia,
	subagent: color.fuchsia,
	skill: color.pink,
}

export class CodingRenderer extends Renderer {
	private readonly verboseToolResults: boolean

	constructor(opts?: CodingRendererOptions) {
		super(opts)
		this.verboseToolResults = opts?.verboseToolResults ?? false
	}

	protected override renderToolCall(toolName: string, input: unknown, indent: string): void {
		const colorFn = TOOL_COLORS[toolName.toLowerCase()] ?? color.blue
		if (this.toolLabelStyle === 'compact') {
			process.stdout.write(`${indent}${colorFn(`[Tool] ${toolName}`)}${this.formatInput(input)}\n`)
		} else {
			process.stdout.write(`${indent}${colorFn('[Tool]')} ${toolName}${this.formatInput(input)}\n`)
		}
	}

	override renderMessage(msg: ModelMessage, indent = ''): void {
		if (!this.verboseToolResults || msg.role !== 'tool' || !Array.isArray(msg.content)) {
			super.renderMessage(msg, indent)
			return
		}
		for (const part of msg.content) {
			if (part.type !== 'tool-result') continue
			const tr = part as { output: unknown; isError?: boolean }
			const output = this.formatVerboseOutput(tr.output)
			const prefix = tr.isError ? color.red('[Error]') : color.lightPurple('[Response]')
			const block = output.length === 0 ? '(empty)' : output.replace(/\n/g, `\n${indent}  `)
			process.stdout.write(`${indent}${prefix} ${block}\n`)
		}
	}

	private formatVerboseOutput(output: unknown): string {
		if (output == null) return ''
		if (typeof output === 'string') return output
		if (typeof output !== 'object') return String(output)
		const typed = output as { type?: string; value?: unknown; reason?: string }
		if (typed.type === 'text' && typeof typed.value === 'string') return typed.value
		if (typed.type === 'error-text' && typeof typed.value === 'string') return typed.value
		if (typed.type === 'json' || typed.type === 'error-json') return JSON.stringify(typed.value, null, 2)
		if (typed.type === 'execution-denied') return typed.reason ? `denied: ${typed.reason}` : 'denied'
		return JSON.stringify(output, null, 2)
	}
}
