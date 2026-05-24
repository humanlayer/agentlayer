import type { ModelMessage } from 'ai'
import type { AgentEvent } from './agent-run'
import * as color from './color'
import type { ModelTokenUsage, TokenUsage } from './token-usage'

const MAX_OUTPUT = 200
const MAX_INPUT_VAL = 120

function truncate(s: string, max: number): string {
	if (s.length <= max) return s
	return `${s.slice(0, max)}${color.dim('…')}`
}

function shortPath(s: string): string {
	const parts = s.split('/')
	if (parts.length <= 3) return s
	return `…/${parts.slice(-2).join('/')}`
}

function visibleWhitespace(s: string): string {
	return s.replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t')
}

function compactText(s: string, max: number): string {
	return truncate(visibleWhitespace(s.trim()), max)
}

function compactVal(v: unknown): string {
	if (v === undefined || v === null) return ''
	if (typeof v === 'string') {
		if (v.startsWith('/') && v.includes('/')) return shortPath(v)
		return compactText(v, 60)
	}
	return truncate(JSON.stringify(v), 60)
}

function compactInput(rawInput: unknown): string {
	if (rawInput == null) return ''
	let input: unknown = rawInput
	if (typeof rawInput === 'string') {
		try {
			input = JSON.parse(rawInput)
		} catch {
			return compactText(rawInput, MAX_INPUT_VAL)
		}
	}
	if (typeof input !== 'object') return compactText(String(input), MAX_INPUT_VAL)
	const obj = input as Record<string, unknown>
	const parts: string[] = []
	for (const [k, v] of Object.entries(obj)) {
		if (v === undefined || v === null) continue
		parts.push(`${color.dim(`${k}=`)}${compactVal(v)}`)
	}
	return ` ${parts.join(' ')}`
}

function prettyTruncatedOutput(output: unknown): string {
	if (output == null) return ''
	if (typeof output === 'string') return compactText(output, MAX_OUTPUT)
	if (typeof output !== 'object') return String(output)
	const o = output as Record<string, unknown>
	if (o.type === 'text' && typeof o.value === 'string') return compactText(o.value, MAX_OUTPUT)
	if (o.type === 'json') return truncate(JSON.stringify(o.value), MAX_OUTPUT)
	if (o.type === 'error-text' && typeof o.value === 'string') return color.red(compactText(o.value, MAX_OUTPUT))
	if (o.type === 'error-json') return color.red(truncate(JSON.stringify(o.value), MAX_OUTPUT))
	if (o.type === 'execution-denied') {
		const denied = o as { reason?: string }
		return color.red(`denied${denied.reason ? `: ${denied.reason}` : ''}`)
	}
	return truncate(JSON.stringify(output), MAX_OUTPUT)
}

export interface RendererOptions {
	showResponse?: boolean
	toolLabelStyle?: 'bracket' | 'compact'
}

export class Renderer {
	private depthMap = new Map<string, number>()
	private toolCallOwner = new Map<string, string>()
	protected showResponse: boolean
	protected toolLabelStyle: 'bracket' | 'compact'

	constructor(opts?: RendererOptions) {
		this.showResponse = opts?.showResponse ?? true
		this.toolLabelStyle = opts?.toolLabelStyle ?? 'bracket'
	}

	handleEvent(event: AgentEvent): void {
		if (event.type === 'message') {
			const depth = this.resolveDepth(event)
			const indent = '  '.repeat(depth)
			this.renderMessage(event.message, indent)
		}
	}

	protected resolveDepth(event: { agentId?: string; parentToolCallId?: string }): number {
		if (!event.agentId) return 0
		if (this.depthMap.has(event.agentId)) return this.depthMap.get(event.agentId)!
		const parentDepth = event.parentToolCallId
			? (this.depthMap.get(this.toolCallOwner.get(event.parentToolCallId) ?? '') ?? 0)
			: 0
		const depth = parentDepth + 1
		this.depthMap.set(event.agentId, depth)
		return depth
	}

	protected formatInput(input: unknown): string {
		return compactInput(input)
	}

	protected renderToolCall(toolName: string, input: unknown, indent: string): void {
		if (this.toolLabelStyle === 'compact') {
			process.stdout.write(`${indent}${color.blue(toolName)}${this.formatInput(input)}\n`)
		} else {
			process.stdout.write(`${indent}${color.blue('[Tool]')} ${toolName}${this.formatInput(input)}\n`)
		}
	}

	renderMessage(msg: ModelMessage, indent = ''): void {
		if (msg.role === 'assistant') {
			const parts = Array.isArray(msg.content)
				? msg.content
				: [{ type: 'text' as const, text: msg.content as string }]
			const toolCalls = parts.filter((p) => p.type === 'tool-call')
			const isParallel = toolCalls.length > 1

			if (isParallel) {
				const prefix =
					this.toolLabelStyle === 'compact'
						? color.blue(`${toolCalls.length} parallel tool calls`)
						: `${color.blue('[Tool]')} ${toolCalls.length} parallel tool calls`
				process.stdout.write(`${indent}${prefix}\n`)
			}

			for (const part of parts) {
				if (part.type === 'text' && (part as { text: string }).text.trim()) {
					process.stdout.write(
						`${indent}${color.green('[Assistant]')} ${(part as { text: string }).text.trim()}\n`,
					)
				} else if (part.type === 'reasoning') {
					const text = (part as { text: string }).text.trim()
					if (text) {
						const oneLine = text.replace(/\n/g, ' ').trim()
						process.stdout.write(
							`${indent}${color.purple('[Thinking]')} ${color.dim(truncate(oneLine, 140))}\n`,
						)
					}
				} else if (part.type === 'tool-call') {
					const tc = part as { toolName: string; input: unknown }
					this.renderToolCall(tc.toolName, tc.input, indent)
				}
			}
		} else if (msg.role === 'tool') {
			const parts = Array.isArray(msg.content) ? msg.content : []
			for (const part of parts) {
				if (part.type === 'tool-result') {
					const tr = part as { toolName: string; output: unknown; isError?: boolean }
					const isErr =
						tr.isError ||
						(typeof tr.output === 'object' &&
							tr.output !== null &&
							'type' in tr.output &&
							((tr.output as { type: string }).type === 'error-text' ||
								(tr.output as { type: string }).type === 'error-json'))
					if (!this.showResponse && !isErr) continue
					const out = prettyTruncatedOutput(tr.output)
					if (isErr) {
						process.stdout.write(`${indent}${color.red('[Error]')} ${color.dim(out || '(empty)')}\n`)
					} else {
						process.stdout.write(
							`${indent}${color.lightPurple('[Response]')} ${color.dim(out || '(empty)')}\n`,
						)
					}
				}
			}
		} else if (msg.role === 'user') {
			const text = Array.isArray(msg.content)
				? (msg.content as Array<{ type: string; text?: string }>)
						.filter((p) => p.type === 'text')
						.map((p) => p.text)
						.join(' ')
				: String(msg.content)
			if (text.trim()) {
				process.stdout.write(`${indent}${color.darkBlue('[User]')} ${text.trim()}\n`)
			}
		} else if (msg.role === 'system') {
			const text = Array.isArray(msg.content)
				? (msg.content as Array<{ type: string; text?: string }>)
						.filter((p) => p.type === 'text')
						.map((p) => p.text)
						.join(' ')
				: String(msg.content)
			if (text.trim()) {
				process.stdout.write(
					`${indent}${color.dim('[System]')} ${color.dim(truncate(text.trim(), MAX_OUTPUT))}\n`,
				)
			}
		}
	}
}

export function renderFinish(result: {
	finishReason: string
	stopCondition?: { name: string; message?: string }
	error?: { type: string; message: string }
	tokenUsage?: TokenUsage
	state?: { contextWindowTokens?: number }
	contextWindowLimit?: number
}): void {
	const reason = result.finishReason
	let label: string
	if (reason === 'error') {
		label = color.red('[Done]')
	} else if (reason === 'maxSteps' || reason === 'stopCondition' || reason === 'interrupted') {
		label = color.yellow('[Done]')
	} else {
		label = color.green('[Done]')
	}
	const displayReason = reason === 'interrupted' ? 'Agent interrupted' : reason
	let line = `\n${label} ${displayReason}`
	if (result.stopCondition) {
		line += ` ${color.dim(`(${result.stopCondition.name}${result.stopCondition.message ? ` — ${result.stopCondition.message}` : ''})`)}`
	}
	if (result.error) {
		line += ` ${color.dim(`[${result.error.type}] ${result.error.message}`)}`
	}
	process.stdout.write(`${line}\n\n`)

	const contextWindowTokens = result.state?.contextWindowTokens
	const contextWindowLimit = result.contextWindowLimit
	if (result.tokenUsage) {
		renderTokenUsage(result.tokenUsage, contextWindowTokens, contextWindowLimit)
	}
}

function shortModelId(modelId: string): string {
	const last = modelId.split('/').pop()
	return last ?? modelId
}

function renderTokenUsage(usage: TokenUsage, contextWindowTokens?: number, contextWindowLimit?: number): void {
	const models = Object.entries(usage.byModel)
	if (models.length === 0) return
	const fmt = (n: number) => n.toLocaleString('en-US')
	const fmtCost = (n: number | undefined) => (n !== undefined ? `~$${n.toFixed(2)}` : '—')
	const displayIds = models.map(([id]) => shortModelId(id))
	const colW = Math.max(5, ...displayIds.map((id) => id.length)) + 2

	// Build context window column if available
	const hasContext = contextWindowTokens !== undefined
	const contextHeader = hasContext ? ` ${'Context'.padStart(16)}` : ''
	const header = `  ${'Model'.padEnd(colW)} ${'Input'.padStart(8)} ${'Cache↓'.padStart(8)} ${'Cache↑'.padStart(8)} ${'Output'.padStart(8)} ${'Cost'.padStart(8)}${contextHeader}`
	process.stdout.write(`${color.dim(header)}\n`)

	for (const [modelId, m] of models) {
		const displayId = shortModelId(modelId)
		const modelUsage = m as ModelTokenUsage
		const contextCol = hasContext
			? ` ${formatContextWindow(contextWindowTokens, contextWindowLimit).padStart(16)}`
			: ''
		const row = `  ${displayId.padEnd(colW)} ${fmt(modelUsage.inputTokens).padStart(8)} ${fmt(modelUsage.cacheReadTokens).padStart(8)} ${fmt(modelUsage.cacheWriteTokens).padStart(8)} ${fmt(modelUsage.outputTokens).padStart(8)} ${fmtCost(modelUsage.estimatedCostUsd).padStart(8)}${contextCol}`
		process.stdout.write(`${row}\n`)
	}

	if (models.length > 1) {
		const sep = `  ${'─'.repeat(colW + 44 + (hasContext ? 17 : 0))}`
		process.stdout.write(`${color.dim(sep)}\n`)
		const t = usage.totals
		const contextCol = hasContext
			? ` ${formatContextWindow(contextWindowTokens, contextWindowLimit).padStart(16)}`
			: ''
		const totalRow = `  ${'Total'.padEnd(colW)} ${fmt(t.inputTokens).padStart(8)} ${fmt(t.cacheReadTokens).padStart(8)} ${fmt(t.cacheWriteTokens).padStart(8)} ${fmt(t.outputTokens).padStart(8)} ${fmtCost(t.estimatedCostUsd).padStart(8)}${contextCol}`
		process.stdout.write(`${totalRow}\n`)
	}
	process.stdout.write('\n')
}

function formatContextWindow(tokens?: number, limit?: number): string {
	if (tokens === undefined) return '—'
	const fmt = (n: number) => n.toLocaleString('en-US')
	if (limit !== undefined) {
		const pct = Math.round((tokens / limit) * 100)
		return `${fmt(tokens)}/${fmt(limit)} (${pct}%)`
	}
	return fmt(tokens)
}
