/**
 * Built-in pre-request hooks for context window transformations.
 *
 * These hooks run before each generateText() call and can transform
 * the messages the model sees without mutating the actual context window
 * (unless `persist` is set).
 *
 * - stripThinkingTokens: removes structured `type: 'reasoning'` parts from assistant
 *   messages (and optionally regex-strips text patterns as a fallback)
 * - deduplicateReads: replaces earlier read results when the same file is read again
 * - truncateOldBashResults: keeps last N bash results in full, truncates earlier ones
 */

import type { ModelMessage } from 'ai'
import type { PreRequestHook } from '../core/hooks'

// ── stripThinkingTokens ───────────────────────────────────────────────────────

export interface StripThinkingOptions {
	/**
	 * Additional regex patterns to strip from assistant text parts.
	 * These are applied as a fallback after structured `type: 'reasoning'` parts
	 * are removed. Useful for models that embed reasoning as raw XML text.
	 */
	textPatterns?: RegExp[]
	/** Whether to persist the stripping. Default: false (view-only) */
	persist?: boolean
}

/**
 * Pre-request hook that strips reasoning from assistant messages.
 *
 * The AI SDK represents model reasoning (Claude extended thinking, OpenAI o1/o3)
 * as structured content parts with `type: 'reasoning'` in assistant message arrays.
 * This hook filters those parts out so the model doesn't re-read its own prior
 * chain-of-thought, saving context window tokens.
 *
 * Optionally also regex-strips text patterns (e.g. `<thinking>...</thinking>`)
 * for models that embed reasoning as raw text rather than structured parts.
 */
export function stripThinkingTokens(opts?: StripThinkingOptions): PreRequestHook {
	const textPatterns = opts?.textPatterns

	return (ctx) => {
		let anyChanged = false
		const transformed: ModelMessage[] = ctx.messages.map((msg) => {
			if (msg.role !== 'assistant') return msg

			// String content — only apply text patterns if configured
			if (typeof msg.content === 'string') {
				if (!textPatterns?.length) return msg
				let text = msg.content
				for (const pattern of textPatterns) {
					const before = text
					text = text.replace(new RegExp(pattern.source, pattern.flags), '')
					if (text !== before) anyChanged = true
				}
				if (text === msg.content) return msg
				return { ...msg, content: text.trim() }
			}

			// Array content — filter out structured reasoning parts, then optionally regex-strip text
			if (Array.isArray(msg.content)) {
				let msgChanged = false

				// Filter out `type: 'reasoning'` parts
				const filtered = msg.content.filter((part) => {
					if (part.type === 'reasoning') {
						msgChanged = true
						return false
					}
					return true
				})

				// Optionally regex-strip text patterns from remaining text parts
				const newContent = textPatterns?.length
					? filtered.map((part) => {
							if (part.type !== 'text') return part
							let text = part.text
							for (const pattern of textPatterns) {
								const before = text
								text = text.replace(new RegExp(pattern.source, pattern.flags), '')
								if (text !== before) msgChanged = true
							}
							if (text === part.text) return part
							return { ...part, text: text.trim() }
						})
					: filtered

				if (msgChanged) {
					anyChanged = true
					return { ...msg, content: newContent }
				}
				return msg
			}

			return msg
		}) as ModelMessage[]

		if (!anyChanged) return ctx.next()
		return ctx.transform(transformed, { persist: opts?.persist })
	}
}

// ── deduplicateReads ──────────────────────────────────────────────────────────

export interface DeduplicateReadsOptions {
	/** Whether to persist the deduplication. Default: false (view-only) */
	persist?: boolean
}

/**
 * Pre-request hook that deduplicates read tool results.
 *
 * When the agent reads the same file multiple times, only the most recent
 * read result is kept in full. Earlier reads of the same file are replaced
 * with a short placeholder note.
 *
 * To find the filePath, the hook looks at the corresponding tool-call in the
 * preceding assistant message that matches the toolCallId.
 */
export function deduplicateReads(opts?: DeduplicateReadsOptions): PreRequestHook {
	const persist = opts?.persist ?? false
	const readToolName = 'read'

	return (ctx) => {
		// First pass: scan assistant messages to find all read tool-calls
		// and track the last toolCallId per filePath
		const lastReadByFile = new Map<string, string>() // filePath -> last toolCallId
		const toolCallToFile = new Map<string, string>() // toolCallId -> filePath

		for (const msg of ctx.messages) {
			if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue
			for (const part of msg.content) {
				if (part.type !== 'tool-call' || part.toolName !== readToolName) continue
				// The AI SDK uses `input` but some contexts use `args` — handle both
				const args = ((part as any).args ?? part.input) as Record<string, unknown> | undefined
				const filePath = (args?.filePath ?? args?.file_path ?? args?.path) as string | undefined
				if (filePath) {
					lastReadByFile.set(filePath, part.toolCallId)
					toolCallToFile.set(part.toolCallId, filePath)
				}
			}
		}

		// Build set of stale toolCallIds (not the last read for their file)
		const staleToolCallIds = new Set<string>()
		const seenByFile = new Map<string, string[]>() // filePath -> toolCallIds in order

		for (const msg of ctx.messages) {
			if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue
			for (const part of msg.content) {
				if (part.type !== 'tool-call' || part.toolName !== readToolName) continue
				const filePath = toolCallToFile.get(part.toolCallId)
				if (!filePath) continue
				const existing = seenByFile.get(filePath) ?? []
				existing.push(part.toolCallId)
				seenByFile.set(filePath, existing)
			}
		}

		for (const [_filePath, toolCallIds] of seenByFile) {
			if (toolCallIds.length <= 1) continue
			const lastId = lastReadByFile.get(_filePath)!
			for (const id of toolCallIds) {
				if (id !== lastId) staleToolCallIds.add(id)
			}
		}

		if (staleToolCallIds.size === 0) return ctx.next()

		// Second pass: replace stale tool results in tool messages
		const transformed = (ctx.messages as ModelMessage[]).map((msg) => {
			if (msg.role !== 'tool' || !Array.isArray(msg.content)) return msg

			let changed = false
			const newContent = msg.content.map((part) => {
				if (part.type !== 'tool-result') return part
				if (!staleToolCallIds.has(part.toolCallId)) return part
				changed = true
				const filePath = toolCallToFile.get(part.toolCallId) ?? 'unknown'
				const placeholder = `[File ${filePath} was read again later — see most recent read.]`
				return {
					...part,
					output:
						typeof part.output === 'string' ? placeholder : { type: 'text' as const, value: placeholder },
				}
			})

			if (!changed) return msg
			return { ...msg, content: newContent }
		}) as ModelMessage[]

		return ctx.transform(transformed, { persist })
	}
}

// ── truncateOldBashResults ────────────────────────────────────────────────────

export interface TruncateOldBashResultsOptions {
	/** Number of most recent bash results to keep in full. Default: 3 */
	keep?: number
	/** Maximum lines to keep for truncated results. Default: 5 */
	summaryLines?: number
	/** Whether to persist. Default: false (view-only) */
	persist?: boolean
}

/**
 * Pre-request hook that truncates old bash tool results.
 *
 * Keeps the last N (default 3) bash results in full. Earlier bash results
 * are truncated to the first `summaryLines` lines with a note about how
 * many lines were omitted.
 */
export function truncateOldBashResults(opts?: TruncateOldBashResultsOptions): PreRequestHook {
	const keep = opts?.keep ?? 3
	const summaryLines = opts?.summaryLines ?? 5
	const persist = opts?.persist ?? false
	const bashToolName = 'bash'

	return (ctx) => {
		// Collect all bash tool-result toolCallIds in order
		const bashToolCallIds: string[] = []

		for (const msg of ctx.messages) {
			if (msg.role !== 'tool' || !Array.isArray(msg.content)) continue
			for (const part of msg.content) {
				if (part.type !== 'tool-result') continue
				if ((part as any).toolName !== bashToolName) continue
				bashToolCallIds.push(part.toolCallId)
			}
		}

		// If there are fewer than keep+1 bash results, nothing to truncate
		if (bashToolCallIds.length <= keep) return ctx.next()

		// The last `keep` toolCallIds should be preserved in full
		const preserveSet = new Set(bashToolCallIds.slice(-keep))

		// Build transformed messages
		const transformed = (ctx.messages as ModelMessage[]).map((msg) => {
			if (msg.role !== 'tool' || !Array.isArray(msg.content)) return msg

			let changed = false
			const newContent = msg.content.map((part) => {
				if (part.type !== 'tool-result') return part
				if ((part as any).toolName !== bashToolName) return part
				if (preserveSet.has(part.toolCallId)) return part

				// Truncate this result
				changed = true
				const output =
					typeof part.output === 'string' ? part.output : (((part.output as any)?.value ?? '') as string)
				const lines = output.split('\n')
				const totalLines = lines.length

				let truncatedOutput: string
				if (totalLines > summaryLines) {
					const keptLines = lines.slice(0, summaryLines).join('\n')
					truncatedOutput = `${keptLines}\n[... ${totalLines} total lines — truncated]`
				} else {
					truncatedOutput = output
				}

				return {
					...part,
					output:
						typeof part.output === 'string'
							? truncatedOutput
							: { type: 'text' as const, value: truncatedOutput },
				}
			})

			if (!changed) return msg
			return { ...msg, content: newContent }
		}) as ModelMessage[]

		return ctx.transform(transformed, { persist })
	}
}
