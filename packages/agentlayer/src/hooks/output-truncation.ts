import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PostToolUseHook } from '../core/hooks'
import { createPostToolUseHook } from '../core/hooks'
import { BashTool } from '../tools/interfaces/bash'
import { GlobTool } from '../tools/interfaces/glob'
import { GrepTool } from '../tools/interfaces/grep'
import { ListTool } from '../tools/interfaces/list'
import type { ReadInput } from '../tools/interfaces/read'
import { ReadTool } from '../tools/interfaces/read'

// ── truncateWithOptions ───────────────────────────────────────────────────────

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

/**
 * Pure function: apply line-count, byte-count, and per-line width caps to a string.
 *
 * Does not save anything to disk — callers handle persistence.
 */
export function truncateWithOptions(output: string, opts?: TruncationOptions): TruncationResult {
	const maxLines = opts?.maxLines ?? 2000
	const maxBytes = opts?.maxBytes ?? 50 * 1024
	const maxLineWidth = opts?.maxLineWidth
	const direction = opts?.direction ?? 'head'

	// Step 1: apply per-line width cap
	let lines = output.split('\n')
	if (maxLineWidth !== undefined) {
		lines = lines.map((line) => (line.length > maxLineWidth ? `${line.slice(0, maxLineWidth)}…` : line))
	}

	const totalLines = lines.length
	const originalByteLength = Buffer.byteLength(output, 'utf8')

	// Step 2: select lines in the correct direction
	const workingLines = direction === 'tail' ? [...lines].reverse() : lines

	// Step 3: accumulate lines until we hit maxLines or maxBytes
	const kept: string[] = []
	let keptBytes = 0
	let hitBytes = false

	for (const line of workingLines) {
		// +1 for the newline character that join('\n') will add between lines
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

	// Step 4: restore original order for tail direction
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

// ── createReadTruncationHook ──────────────────────────────────────────────────

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

/**
 * Create a postToolUse hook that applies per-line width capping and line/byte
 * truncation to Read tool output.
 *
 * Does NOT save to disk — the file is already on disk and the model can re-read
 * it with offset/limit to access truncated content.
 *
 * Appends a continuation hint when truncation occurs, derived from the input's
 * offset and limit values.
 */
export function createReadTruncationHook(opts?: ReadTruncationOptions): PostToolUseHook {
	const maxLines = opts?.maxLines ?? 2000
	const maxBytes = opts?.maxBytes ?? 50 * 1024
	const maxLineWidth = opts?.maxLineWidth ?? 2000
	const customHint = opts?.hint

	return createPostToolUseHook(ReadTool, (ctx) => {
		const input = ctx.input as ReadInput
		const result = truncateWithOptions(ctx.output, {
			maxLines,
			maxBytes,
			maxLineWidth,
			direction: 'head',
		})

		// If content is unchanged (no width cap, no line/byte drop), pass through.
		const contentChanged = result.content !== ctx.output
		if (!contentChanged) {
			return ctx.done()
		}

		// If only per-line width capping occurred (no lines dropped), return mutated
		// content without a continuation hint — the file is still readable at the same offset.
		if (!result.truncated) {
			return ctx.done(result.content)
		}

		// Lines were dropped — derive the offset context for the continuation hint.
		// The serialized output includes numbered lines starting at input.offset (default 1).
		const startLine = input.offset ?? 1
		// We kept result.content lines — count them to find the end line number.
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

/** Pre-composed instance with sane defaults. */
export const readTruncationHook = createReadTruncationHook()

// ── saveFullOutput ────────────────────────────────────────────────────────────

/**
 * Write `output` to a uniquely-named temp file and return the file path.
 *
 * Uses `os.tmpdir()` with a `agent-tool-output-` prefix directory.
 * OS temp directory handles cleanup — no scheduler needed.
 */
export async function saveFullOutput(output: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'agent-tool-output-'))
	const filePath = join(dir, 'output.txt')
	await writeFile(filePath, output, 'utf8')
	return filePath
}

// ── OutputTruncationOptions ───────────────────────────────────────────────────

export interface OutputTruncationOptions {
	/** Maximum number of lines to return. Default: 2000 */
	maxLines?: number
	/** Maximum byte size of the returned content. Default: 50 * 1024 */
	maxBytes?: number
	/** Whether to keep the head or tail of the output. Default varies by tool */
	direction?: 'head' | 'tail'
	/** Custom hint generator. Receives truncation context; return the hint string. */
	hint?: (ctx: { toolName: string; outputPath: string }) => string
}

// ── createBashOutputTruncationHook ────────────────────────────────────────────

/**
 * Create a postToolUse hook that saves the full bash output to a temp file,
 * then truncates from the tail (most recent output) with a save-to-disk hint.
 *
 * Default direction is 'tail' — for commands that print incrementally, the
 * last N lines are typically the most relevant.
 */
export function createBashOutputTruncationHook(opts?: OutputTruncationOptions): PostToolUseHook {
	const maxLines = opts?.maxLines ?? 2000
	const maxBytes = opts?.maxBytes ?? 50 * 1024
	const direction = opts?.direction ?? 'tail'
	const customHint = opts?.hint

	return createPostToolUseHook(BashTool, async (ctx) => {
		const result = truncateWithOptions(ctx.output, { maxLines, maxBytes, direction })

		if (!result.truncated) {
			return ctx.done()
		}

		const outputPath = await saveFullOutput(ctx.output)

		let hint: string
		if (customHint) {
			hint = customHint({ toolName: ctx.toolName, outputPath })
		} else {
			hint = `(Output truncated. Full output saved to ${outputPath})`
		}

		return ctx.done(`${result.content}\n\n${hint}`)
	})
}

/** Pre-composed bash output truncation hook with sane defaults. */
export const bashOutputTruncationHook = createBashOutputTruncationHook()

// ── createGlobOutputTruncationHook ────────────────────────────────────────────

/**
 * Create a postToolUse hook that saves the full glob output to a temp file,
 * then truncates from the head with a save-to-disk hint.
 */
export function createGlobOutputTruncationHook(opts?: OutputTruncationOptions): PostToolUseHook {
	const maxLines = opts?.maxLines ?? 2000
	const maxBytes = opts?.maxBytes ?? 50 * 1024
	const direction = opts?.direction ?? 'head'
	const customHint = opts?.hint

	return createPostToolUseHook(GlobTool, async (ctx) => {
		const result = truncateWithOptions(ctx.output, { maxLines, maxBytes, direction })

		if (!result.truncated) {
			return ctx.done()
		}

		const outputPath = await saveFullOutput(ctx.output)

		let hint: string
		if (customHint) {
			hint = customHint({ toolName: ctx.toolName, outputPath })
		} else {
			hint = `(Output truncated. Full output saved to ${outputPath})`
		}

		return ctx.done(`${result.content}\n\n${hint}`)
	})
}

/** Pre-composed glob output truncation hook with sane defaults. */
export const globOutputTruncationHook = createGlobOutputTruncationHook()

// ── createGrepOutputTruncationHook ────────────────────────────────────────────

/**
 * Create a postToolUse hook that saves the full grep output to a temp file,
 * then truncates from the head with a save-to-disk hint.
 */
export function createGrepOutputTruncationHook(opts?: OutputTruncationOptions): PostToolUseHook {
	const maxLines = opts?.maxLines ?? 2000
	const maxBytes = opts?.maxBytes ?? 50 * 1024
	const direction = opts?.direction ?? 'head'
	const customHint = opts?.hint

	return createPostToolUseHook(GrepTool, async (ctx) => {
		const result = truncateWithOptions(ctx.output, { maxLines, maxBytes, direction })

		if (!result.truncated) {
			return ctx.done()
		}

		const outputPath = await saveFullOutput(ctx.output)

		let hint: string
		if (customHint) {
			hint = customHint({ toolName: ctx.toolName, outputPath })
		} else {
			hint = `(Output truncated. Full output saved to ${outputPath})`
		}

		return ctx.done(`${result.content}\n\n${hint}`)
	})
}

/** Pre-composed grep output truncation hook with sane defaults. */
export const grepOutputTruncationHook = createGrepOutputTruncationHook()

// ── createListOutputTruncationHook ────────────────────────────────────────────

/**
 * Create a postToolUse hook that saves the full list output to a temp file,
 * then truncates from the head with a save-to-disk hint.
 */
export function createListOutputTruncationHook(opts?: OutputTruncationOptions): PostToolUseHook {
	const maxLines = opts?.maxLines ?? 2000
	const maxBytes = opts?.maxBytes ?? 50 * 1024
	const direction = opts?.direction ?? 'head'
	const customHint = opts?.hint

	return createPostToolUseHook(ListTool, async (ctx) => {
		const result = truncateWithOptions(ctx.output, { maxLines, maxBytes, direction })

		if (!result.truncated) {
			return ctx.done()
		}

		const outputPath = await saveFullOutput(ctx.output)

		let hint: string
		if (customHint) {
			hint = customHint({ toolName: ctx.toolName, outputPath })
		} else {
			hint = `(Output truncated. Full output saved to ${outputPath})`
		}

		return ctx.done(`${result.content}\n\n${hint}`)
	})
}

/** Pre-composed list output truncation hook with sane defaults. */
export const listOutputTruncationHook = createListOutputTruncationHook()

// ── saneDefaultOutputTruncationHooks ─────────────────────────────────────────

/**
 * Pre-composed array of all output truncation hooks with sane defaults.
 * Drop this into an agent config's `hooks.postToolUse` for immediate benefit.
 *
 * @example
 * ```ts
 * const agent = new Agent({
 *   tools: { read, bash, glob, grep, list },
 *   hooks: { postToolUse: saneDefaultOutputTruncationHooks },
 * })
 * ```
 */
export const saneDefaultOutputTruncationHooks: PostToolUseHook[] = [
	readTruncationHook,
	bashOutputTruncationHook,
	globOutputTruncationHook,
	grepOutputTruncationHook,
	listOutputTruncationHook,
]
