import { createPostToolUseHook, type PostToolUseHook } from '@humanlayer/agentlayer-core/hooks'
import { ApplyPatchTool, DeleteFileTool, EditTool, ReadTool, WriteTool } from '@humanlayer/agentlayer-core/interfaces'
import type { EditResult, YjsFilesystem } from '@humanlayer/yjs-fs'

const SELECTION_FADE_MS = 5_000

export interface YjsFsPresenceHookOptions {
	selectionFadeMs?: number
}

export function lineToOffset(content: string, line: number): number {
	if (line <= 1) return 0
	let currentLine = 1
	for (let index = 0; index < content.length; index++) {
		if (content[index] === '\n') {
			currentLine++
			if (currentLine === line) return index + 1
		}
	}
	return content.length
}

export function lineEndOffset(content: string, line: number): number {
	if (line <= 1) {
		const firstNewline = content.indexOf('\n')
		return firstNewline === -1 ? content.length : firstNewline
	}

	const start = lineToOffset(content, line)
	const nextNewline = content.indexOf('\n', start)
	return nextNewline === -1 ? content.length : nextNewline
}

function tryReadTextFile(fs: YjsFilesystem, filePath: string): string | undefined {
	try {
		return fs.readFile(filePath)
	} catch {
		return undefined
	}
}

function trySetSelection(fs: YjsFilesystem, filePath: string, anchorOffset: number, headOffset: number): boolean {
	try {
		fs.setLocalSelection(filePath, anchorOffset, headOffset)
		return true
	} catch {
		return false
	}
}

function firstPatchedPath(patchText: string): string | undefined {
	for (const line of patchText.split('\n')) {
		if (line.startsWith('*** Update File: ') || line.startsWith('*** Add File: ')) {
			const path = line.slice(line.indexOf(':') + 1).trim()
			if (path) return path
		}
		if (line.startsWith('+++ ')) {
			const path = line.slice(4).trim()
			if (path && path !== '/dev/null') return path.replace(/^b\//, '')
		}
		if (line.startsWith('--- ')) {
			const path = line.slice(4).trim()
			if (path && path !== '/dev/null') return path.replace(/^a\//, '')
		}
	}
	return undefined
}

function updatePresence(fs: YjsFilesystem, patch: Record<string, unknown>): void {
	try {
		fs.updateLocalPresence(patch)
	} catch {
		// Presence is optional; hooks should not fail tool execution when awareness is absent.
	}
}

export function createYjsFsPresenceHooks(fs: YjsFilesystem, opts: YjsFsPresenceHookOptions = {}): PostToolUseHook[] {
	let fadeTimer: ReturnType<typeof setTimeout> | undefined
	const selectionFadeMs = opts.selectionFadeMs ?? SELECTION_FADE_MS

	function scheduleFade() {
		if (fadeTimer) clearTimeout(fadeTimer)
		fadeTimer = setTimeout(() => {
			try {
				fs.clearLocalSelection()
			} catch {
				// Presence is optional.
			}
		}, selectionFadeMs)
	}

	const readHook = createPostToolUseHook(ReadTool, (ctx) => {
		updatePresence(fs, { currentFile: ctx.input.file_path, action: 'reading' })
		const content = tryReadTextFile(fs, ctx.input.file_path)
		if (content !== undefined && trySetSelection(fs, ctx.input.file_path, 0, content.length)) {
			scheduleFade()
		}
		return ctx.done()
	})

	const editHook = createPostToolUseHook(EditTool, (ctx) => {
		const editResult = (ctx.rawOutput as { editResult?: EditResult } | undefined)?.editResult
		updatePresence(fs, {
			currentFile: ctx.input.file_path,
			action: 'editing',
			editResult,
		})

		if (editResult?.affectedLines) {
			const content = tryReadTextFile(fs, ctx.input.file_path)
			if (content !== undefined) {
				const anchor = lineToOffset(content, editResult.affectedLines.start)
				const head = lineEndOffset(content, editResult.affectedLines.end)
				if (trySetSelection(fs, ctx.input.file_path, anchor, head)) scheduleFade()
			}
		}
		return ctx.done()
	})

	const writeHook = createPostToolUseHook(WriteTool, (ctx) => {
		updatePresence(fs, { currentFile: ctx.input.file_path, action: 'writing' })
		const content = tryReadTextFile(fs, ctx.input.file_path)
		if (content !== undefined && trySetSelection(fs, ctx.input.file_path, 0, content.length)) {
			scheduleFade()
		}
		return ctx.done()
	})

	const applyPatchHook = createPostToolUseHook(ApplyPatchTool, (ctx) => {
		const filePath = firstPatchedPath(ctx.input.patch_text) ?? 'patch'
		updatePresence(fs, { currentFile: filePath, action: 'patching' })
		const content = filePath === 'patch' ? undefined : tryReadTextFile(fs, filePath)
		if (content !== undefined && trySetSelection(fs, filePath, 0, content.length)) scheduleFade()
		return ctx.done()
	})

	const deleteHook = createPostToolUseHook(DeleteFileTool, (ctx) => {
		updatePresence(fs, { currentFile: ctx.input.file_path, action: 'deleting' })
		try {
			fs.clearLocalSelection()
		} catch {
			// Presence is optional.
		}
		return ctx.done()
	})

	return [readHook, editHook, writeHook, applyPatchHook, deleteHook]
}
