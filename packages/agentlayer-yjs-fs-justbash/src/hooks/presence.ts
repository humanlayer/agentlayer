import { createPostToolUseHook, type PostToolUseHook } from '@humanlayer/agentlayer-core/hooks'
import { BashTool } from '@humanlayer/agentlayer-core/interfaces'
import type { YjsFilesystem } from '@humanlayer/yjs-fs'
import type { YjsFsBashOperation } from '../adapter'
import type { YjsFsBashToolResult } from '../tools/bash'

const SELECTION_FADE_MS = 5_000

export interface YjsFsBashPresenceHookOptions {
	selectionFadeMs?: number
}

function updatePresence(fs: YjsFilesystem, patch: Record<string, unknown>): void {
	try {
		fs.updateLocalPresence(patch)
	} catch {
		// Presence is optional; hooks should not fail tool execution when awareness is absent.
	}
}

function operationPath(operation: YjsFsBashOperation): string {
	return operation.toPath ?? operation.path
}

function operationAction(operation: YjsFsBashOperation): string {
	switch (operation.type) {
		case 'read':
			return 'reading'
		case 'write':
		case 'append':
			return 'writing'
		case 'mkdir':
			return 'creating directory'
		case 'delete':
			return 'deleting'
		case 'copy':
			return 'copying'
		case 'move':
			return 'moving'
		case 'list':
			return 'listing'
	}
}

function mostRelevantOperation(operations: YjsFsBashOperation[]): YjsFsBashOperation | undefined {
	return (
		operations.findLast((operation) => ['write', 'append', 'copy', 'move'].includes(operation.type)) ??
		operations.findLast((operation) => operation.type === 'read') ??
		operations.at(-1)
	)
}

function trySetFileSelection(fs: YjsFilesystem, path: string): boolean {
	try {
		const content = fs.readFile(path)
		fs.setLocalSelection(path, 0, content.length)
		return true
	} catch {
		return false
	}
}

export function createYjsFsBashPresenceHooks(
	fs: YjsFilesystem,
	opts: YjsFsBashPresenceHookOptions = {},
): PostToolUseHook[] {
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

	const bashHook = createPostToolUseHook(BashTool, (ctx) => {
		const rawOutput = ctx.rawOutput as YjsFsBashToolResult | undefined
		const operations = rawOutput?.operations ?? []
		const operation = mostRelevantOperation(operations)

		if (!operation) {
			updatePresence(fs, { action: 'running bash' })
			return ctx.done()
		}

		const path = operationPath(operation)
		updatePresence(fs, {
			currentFile: path,
			action: operationAction(operation),
			bashOperation: operation,
			bashOperations: operations,
		})

		if (trySetFileSelection(fs, path)) scheduleFade()
		return ctx.done()
	})

	return [bashHook]
}
