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

export const saneDefaultOutputTruncationHooks: PostToolUseHook[] = [
	readTruncationHook,
	bashOutputTruncationHook,
	globOutputTruncationHook,
	grepOutputTruncationHook,
	listOutputTruncationHook,
]
