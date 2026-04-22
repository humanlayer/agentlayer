import type { ModelMessage } from 'ai'
import type { PreRequestHook } from './pre-request'

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
