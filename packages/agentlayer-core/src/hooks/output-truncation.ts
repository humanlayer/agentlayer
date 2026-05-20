import type { ReadInput } from '../interfaces/read'
import { ReadTool } from '../interfaces/read'
import type { PostToolUseHook } from './post-tool-use'
import { createPostToolUseHook } from './typed'

export interface TruncationOptions {
	/** Maximum number of lines to return. Default: 2000 */
	maxLines?: number
	/** Maximum byte size of the returned content. Default: 50 * 1024 */
	maxBytes?: number
	/** Maximum characters per line before truncating the line. Default: undefined (no cap) */
	maxLineWidth?: number
	/** Whether to keep the head or tail of the output. Default: 'head' */
	direction?: 'head' | 'tail'
}

export interface TruncationResult {
	/** The (possibly truncated) content string. */
	content: string
	/** Whether any truncation occurred. */
	truncated: boolean
	/** Number of lines that were dropped (0 if not truncated). */
	truncatedLines: number
	/** Number of bytes that were dropped (0 if not truncated). */
	truncatedBytes: number
	/** True when the byte cap was the binding constraint (vs line cap). */
	hitBytes: boolean
}

export function truncateWithOptions(output: string, opts?: TruncationOptions): TruncationResult {
	const maxLines = opts?.maxLines ?? 2000
	const maxBytes = opts?.maxBytes ?? 50 * 1024
	const maxLineWidth = opts?.maxLineWidth
	const direction = opts?.direction ?? 'head'

	let lines = output.split('\n')
	if (maxLineWidth !== undefined) {
		lines = lines.map((line) => (line.length > maxLineWidth ? `${line.slice(0, maxLineWidth)}...` : line))
	}

	const totalLines = lines.length
	const originalByteLength = Buffer.byteLength(output, 'utf8')
	const workingLines = direction === 'tail' ? [...lines].reverse() : lines
	const kept: string[] = []
	let keptBytes = 0
	let hitBytes = false

	for (const line of workingLines) {
		const lineBytes = Buffer.byteLength(line, 'utf8') + 1
		if (kept.length >= maxLines) {
			break
		}
		if (keptBytes + lineBytes > maxBytes) {
			hitBytes = true
			break
		}
		kept.push(line)
		keptBytes += lineBytes
	}

	if (direction === 'tail') {
		kept.reverse()
	}

	const truncated = kept.length < totalLines
	const truncatedLines = totalLines - kept.length
	const content = kept.join('\n')
	const keptByteLength = Buffer.byteLength(content, 'utf8')
	const truncatedBytes = originalByteLength - keptByteLength

	return {
		content,
		truncated,
		truncatedLines,
		truncatedBytes,
		hitBytes,
	}
}

export interface ReadTruncationOptions {
	/** Maximum number of lines to return. Default: 2000 */
	maxLines?: number
	/** Maximum byte size of the returned content. Default: 50 * 1024 */
	maxBytes?: number
	/** Maximum characters per line before truncating the line. Default: 2000 */
	maxLineWidth?: number
	/** Custom hint generator. Receives truncation context; return the hint string. */
	hint?: (ctx: {
		toolName: string
		truncatedLines: number
		truncatedBytes: number
		hitBytes: boolean
		startLine: number
		endLine: number
		nextOffset: number
	}) => string
}

export function createReadTruncationHook(opts?: ReadTruncationOptions): PostToolUseHook {
	const maxLines = opts?.maxLines ?? 2000
	const maxBytes = opts?.maxBytes ?? 50 * 1024
	const maxLineWidth = opts?.maxLineWidth ?? 2000
	const customHint = opts?.hint

	return createPostToolUseHook(ReadTool, (ctx) => {
		if (typeof ctx.output !== 'string') {
			return ctx.done()
		}

		const input = ctx.input as ReadInput
		const result = truncateWithOptions(ctx.output, {
			maxLines,
			maxBytes,
			maxLineWidth,
			direction: 'head',
		})

		const contentChanged = result.content !== ctx.output
		if (!contentChanged) {
			return ctx.done()
		}

		if (!result.truncated) {
			return ctx.done(result.content)
		}

		const startLine = input.offset ?? 1
		const keptLineCount = result.content.split('\n').length
		const endLine = startLine + keptLineCount - 1
		const nextOffset = endLine + 1

		let hint: string
		if (customHint) {
			hint = customHint({
				toolName: ctx.toolName,
				truncatedLines: result.truncatedLines,
				truncatedBytes: result.truncatedBytes,
				hitBytes: result.hitBytes,
				startLine,
				endLine,
				nextOffset,
			})
		} else if (result.hitBytes) {
			hint = `(Output capped at ${Math.round(maxBytes / 1024)} KB. Showing lines ${startLine}-${endLine}. Use offset=${nextOffset} to continue.)`
		} else {
			hint = `(Showing lines ${startLine}-${endLine}. Use offset=${nextOffset} to continue.)`
		}

		return ctx.done(`${result.content}\n\n${hint}`)
	})
}

export const readTruncationHook = createReadTruncationHook()
