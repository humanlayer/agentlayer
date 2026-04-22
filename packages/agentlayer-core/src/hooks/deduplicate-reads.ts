import type { ModelMessage } from 'ai'
import type { PreRequestHook } from './pre-request'

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
