import { createPostToolUseHook, type PostToolUseHook } from '@humanlayer/agentlayer-core/hooks'
import type { YjsFilesystem } from '@humanlayer/yjs-fs'
import type { YjsFsSecureExecOperation } from '../adapter'
import { secureExecInput, type YjsFsSecureExecToolResult } from '../tools/exec'

const SELECTION_FADE_MS = 5_000

const SecureExecToolInterface = { name: 'secure_exec', input: secureExecInput }

export interface YjsFsSecureExecPresenceHookOptions {
	selectionFadeMs?: number
}

function operationPath(operation: YjsFsSecureExecOperation): string {
	return operation.toPath ?? operation.path
}

function operationAction(operation: YjsFsSecureExecOperation): string {
	switch (operation.type) {
		case 'read':
			return 'reading'
		case 'write':
		case 'truncate':
			return 'writing'
		case 'mkdir':
			return 'creating directory'
		case 'delete':
			return 'deleting'
		case 'rename':
			return 'moving'
		case 'list':
			return 'listing'
	}
}

function mostRelevantOperation(operations: YjsFsSecureExecOperation[]): YjsFsSecureExecOperation | undefined {
	return (
		operations.findLast((operation) => ['write', 'truncate', 'rename'].includes(operation.type)) ??
		operations.findLast((operation) => operation.type === 'read') ??
		operations.at(-1)
	)
}

function updatePresence(fs: YjsFilesystem, patch: Record<string, unknown>): void {
	try {
		fs.updateLocalPresence(patch)
	} catch {
		// Presence is optional; hooks should not fail tool execution when awareness is absent.
	}
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

export function createYjsFsSecureExecPresenceHooks(
	fs: YjsFilesystem,
	opts: YjsFsSecureExecPresenceHookOptions = {},
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

	const secureExecHook = createPostToolUseHook(SecureExecToolInterface, (ctx) => {
		const rawOutput = ctx.rawOutput as YjsFsSecureExecToolResult | undefined
		const operations = rawOutput?.operations ?? []
		const operation = mostRelevantOperation(operations)

		if (!operation) {
			updatePresence(fs, { action: 'running secure-exec' })
			return ctx.done()
		}

		const path = operationPath(operation)
		updatePresence(fs, {
			currentFile: path,
			action: operationAction(operation),
			secureExecOperation: operation,
			secureExecOperations: operations,
		})

		if (trySetFileSelection(fs, path)) scheduleFade()
		return ctx.done()
	})

	return [secureExecHook]
}
