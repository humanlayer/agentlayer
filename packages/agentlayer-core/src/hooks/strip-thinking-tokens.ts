import type { ModelMessage } from 'ai'
import type { PreRequestHook } from '../hooks'

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
