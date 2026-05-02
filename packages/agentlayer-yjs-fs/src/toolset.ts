import type { PostToolUseHook } from '@humanlayer/agentlayer-core/hooks'
import { YjsFilesystem } from '@humanlayer/yjs-fs'
import type { Awareness } from 'y-protocols/awareness'
import type * as Y from 'yjs'
import { createYjsFsPresenceHooks, type YjsFsPresenceHookOptions } from './hooks'
import {
	createYjsFsApplyPatchTool,
	createYjsFsEditTool,
	createYjsFsGlobTool,
	createYjsFsGrepTool,
	createYjsFsListTool,
	createYjsFsReadTool,
	createYjsFsWriteTool,
} from './tools'

export type CreateYjsFsToolsetOptions =
	| { fs: YjsFilesystem; doc?: never; awareness?: never; presence?: YjsFsPresenceHookOptions }
	| { fs?: never; doc?: Y.Doc; awareness?: Awareness | null; presence?: YjsFsPresenceHookOptions }

/**
 * Creates agentlayer tools and presence hooks bound to a shared YjsFilesystem.
 *
 * This factory does not create, connect, or await a Yjs provider. If the tools
 * need remote document state, initialize and sync the provider before calling
 * this factory or before executing the returned tools.
 */
export function createYjsFsToolset(opts: CreateYjsFsToolsetOptions = {}) {
	const fs = opts.fs ?? new YjsFilesystem({ doc: opts.doc, awareness: opts.awareness })

	return {
		fs,
		tools: {
			read: createYjsFsReadTool(fs),
			write: createYjsFsWriteTool(fs),
			edit: createYjsFsEditTool(fs),
			apply_patch: createYjsFsApplyPatchTool(fs),
			glob: createYjsFsGlobTool(fs),
			grep: createYjsFsGrepTool(fs),
			list: createYjsFsListTool(fs),
		},
		hooks: {
			postToolUse: createYjsFsPresenceHooks(fs, opts.presence),
		},
	} as const satisfies {
		fs: YjsFilesystem
		tools: Record<string, unknown>
		hooks: { postToolUse: PostToolUseHook[] }
	}
}
