import type { YjsStreamFS } from '@humanlayer/agentlayer-stream-fs-yjs'
import type { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { createPostToolUseHook, type PostToolUseHook } from '../../core/hooks'
import { CreateFileTool, DeleteFileTool, EditTool, ReadTool } from '../interfaces'

const SELECTION_FADE_MS = 5_000

/**
 * Convert a 1-based line number to a character offset in text.
 * Returns the offset of the first character on that line.
 */
function lineToOffset(text: string, line: number): number {
	let offset = 0
	for (let i = 1; i < line; i++) {
		const nl = text.indexOf('\n', offset)
		if (nl === -1) return text.length
		offset = nl + 1
	}
	return offset
}

/**
 * Convert a 1-based line number to the end-of-line character offset.
 * Returns the offset just after the last character on that line (before newline).
 */
function lineEndOffset(text: string, line: number): number {
	let offset = 0
	for (let i = 1; i < line; i++) {
		const nl = text.indexOf('\n', offset)
		if (nl === -1) return text.length
		offset = nl + 1
	}
	const nl = text.indexOf('\n', offset)
	return nl === -1 ? text.length : nl
}

/**
 * Set a Y.js-compatible selection on awareness so y-monaco renders it
 * as the agent's colored remote selection.
 */
function setSelection(awareness: Awareness, ytext: Y.Text, anchorOffset: number, headOffset: number) {
	awareness.setLocalStateField('selection', {
		anchor: Y.createRelativePositionFromTypeIndex(ytext, anchorOffset),
		head: Y.createRelativePositionFromTypeIndex(ytext, headOffset),
	})
}

/**
 * Creates postToolUse hooks that update Y.js awareness state
 * with the current file and action whenever the agent reads,
 * edits, creates, or deletes a file.
 *
 * Also sets a Y.js selection on awareness so y-monaco renders
 * the affected range as the agent's colored cursor/selection.
 */
export function createPresenceHooks(awareness: Awareness, fs: YjsStreamFS): PostToolUseHook[] {
	let fadeTimer: ReturnType<typeof setTimeout> | undefined

	function update(fields: Record<string, unknown>) {
		for (const [key, value] of Object.entries(fields)) {
			awareness.setLocalStateField(key, value)
		}
	}

	function scheduleFade() {
		clearTimeout(fadeTimer)
		fadeTimer = setTimeout(() => {
			awareness.setLocalStateField('selection', null)
		}, SELECTION_FADE_MS)
	}

	function getYText(filePath: string): Y.Text | null {
		const subdoc = fs.doc.getMap<Y.Doc>('files').get(filePath)
		if (!subdoc) return null
		return subdoc.getText('content')
	}

	const readHook = createPostToolUseHook(ReadTool, (ctx) => {
		update({ currentFile: ctx.input.filePath, action: 'reading' })

		// Select entire file content
		const ytext = getYText(ctx.input.filePath)
		if (ytext) {
			const content = ytext.toString()
			setSelection(awareness, ytext, 0, content.length)
			scheduleFade()
		}

		return ctx.done()
	})

	const editHook = createPostToolUseHook(EditTool, (ctx) => {
		const raw = ctx.rawOutput as
			| {
					editResult?: {
						path: string
						editIndex: number
						editLine: number
						affectedLines: { start: number; end: number }
					}
			  }
			| undefined
		update({
			currentFile: ctx.input.filePath,
			action: 'editing',
			editResult: raw?.editResult ?? null,
		})

		// Select affected lines
		const ytext = getYText(ctx.input.filePath)
		if (ytext && raw?.editResult?.affectedLines) {
			const content = ytext.toString()
			const { start, end } = raw.editResult.affectedLines
			const anchor = lineToOffset(content, start)
			const head = lineEndOffset(content, end)
			setSelection(awareness, ytext, anchor, head)
			scheduleFade()
		}

		return ctx.done()
	})

	const createHook = createPostToolUseHook(CreateFileTool, (ctx) => {
		update({ currentFile: ctx.input.filePath, action: 'creating' })

		// Select entire new file content
		const ytext = getYText(ctx.input.filePath)
		if (ytext) {
			const content = ytext.toString()
			setSelection(awareness, ytext, 0, content.length)
			scheduleFade()
		}

		return ctx.done()
	})

	const deleteHook = createPostToolUseHook(DeleteFileTool, (ctx) => {
		update({ currentFile: ctx.input.filePath, action: 'deleting' })
		// Clear selection on delete
		awareness.setLocalStateField('selection', null)
		return ctx.done()
	})

	return [readHook, editHook, createHook, deleteHook]
}
