import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PostToolUseHook, ToolInterface } from '@humanlayer/agentlayer-core'
import {
	BashTool,
	createPostToolUseHook,
	GlobTool,
	GrepTool,
	ListTool,
	readTruncationHook,
	truncateWithOptions,
} from '@humanlayer/agentlayer-core'

export { createReadTruncationHook, readTruncationHook, truncateWithOptions } from '@humanlayer/agentlayer-core'

export async function saveFullOutput(output: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'agent-tool-output-'))
	const filePath = join(dir, 'output.txt')
	await writeFile(filePath, output, 'utf8')
	return filePath
}

export interface OutputTruncationOptions {
	maxLines?: number
	maxBytes?: number
	direction?: 'head' | 'tail'
	hint?: (ctx: { toolName: string; outputPath: string }) => string
}

export interface WebOutputTruncationOptions {
	maxLines?: number
	maxBytes?: number
}

function createOutputTruncationHook(
	Tool: ToolInterface<any, any>,
	defaultDirection: 'head' | 'tail',
	opts?: OutputTruncationOptions,
): PostToolUseHook {
	const maxLines = opts?.maxLines ?? 2000
	const maxBytes = opts?.maxBytes ?? 50 * 1024
	const direction = opts?.direction ?? defaultDirection
	const customHint = opts?.hint

	return createPostToolUseHook(Tool, async (ctx) => {
		if (typeof ctx.output !== 'string') {
			return ctx.done()
		}

		const result = truncateWithOptions(ctx.output, { maxLines, maxBytes, direction })
		if (!result.truncated) {
			return ctx.done()
		}

		const outputPath = await saveFullOutput(ctx.output)
		const hint = customHint
			? customHint({ toolName: ctx.toolName, outputPath })
			: `(Output truncated. Full output saved to ${outputPath})`

		return ctx.done(`${result.content}\n\n${hint}`)
	})
}

export function createBashOutputTruncationHook(opts?: OutputTruncationOptions): PostToolUseHook {
	return createOutputTruncationHook(BashTool, 'tail', opts)
}

export const bashOutputTruncationHook = createBashOutputTruncationHook()

export function createGlobOutputTruncationHook(opts?: OutputTruncationOptions): PostToolUseHook {
	return createOutputTruncationHook(GlobTool, 'head', opts)
}

export const globOutputTruncationHook = createGlobOutputTruncationHook()

export function createGrepOutputTruncationHook(opts?: OutputTruncationOptions): PostToolUseHook {
	return createOutputTruncationHook(GrepTool, 'head', opts)
}

export const grepOutputTruncationHook = createGrepOutputTruncationHook()

export function createListOutputTruncationHook(opts?: OutputTruncationOptions): PostToolUseHook {
	return createOutputTruncationHook(ListTool, 'head', opts)
}

export const listOutputTruncationHook = createListOutputTruncationHook()

const WEB_TOOL_NAMES = new Set(['web_fetch', 'web_search'])

function webOutputHint(input: { outputPath: string; maxBytes: number; keptLines: number; hitBytes: boolean }): string {
	const read = (offset: number) => `read(file_path="${input.outputPath}", offset=${offset})`
	if (input.keptLines === 0) {
		return `(Output truncated. Full output saved to ${input.outputPath}. The first line exceeds the ${input.maxBytes}-byte limit. Use ${read(1)} to inspect it.)`
	}

	const byteLimit = input.hitBytes ? ` (${input.maxBytes}-byte limit)` : ''
	const nextOffset = input.keptLines + 1
	return `(Output truncated. Full output saved to ${input.outputPath}. Showing lines 1-${input.keptLines}${byteLimit}. Use ${read(nextOffset)} to continue.)`
}

export function createWebOutputTruncationHook(opts?: WebOutputTruncationOptions): PostToolUseHook {
	const maxLines = opts?.maxLines ?? 2000
	const maxBytes = opts?.maxBytes ?? 50 * 1024

	return async (ctx) => {
		if (!WEB_TOOL_NAMES.has(ctx.toolName) || typeof ctx.output !== 'string') {
			return ctx.done()
		}

		const result = truncateWithOptions(ctx.output, { maxLines, maxBytes, direction: 'head' })
		if (!result.truncated) {
			return ctx.done()
		}

		const outputPath = await saveFullOutput(ctx.output)
		const keptLines = ctx.output.split('\n').length - result.truncatedLines
		return ctx.done(
			`${result.content}\n\n${webOutputHint({
				outputPath,
				maxBytes,
				keptLines,
				hitBytes: result.hitBytes,
			})}`,
		)
	}
}

export const webOutputTruncationHook = createWebOutputTruncationHook()

export const saneDefaultOutputTruncationHooks: PostToolUseHook[] = [
	readTruncationHook,
	bashOutputTruncationHook,
	globOutputTruncationHook,
	grepOutputTruncationHook,
	listOutputTruncationHook,
	webOutputTruncationHook,
]
