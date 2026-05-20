import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import type { PostToolUseHook, PreToolUseHook } from '@humanlayer/agentlayer-core'
import { createPostToolUseHook, createPreToolUseHook } from '@humanlayer/agentlayer-core'
import { ApplyPatchTool, EditTool, ReadTool, WriteTool } from '@humanlayer/agentlayer-core/interfaces'
import { type PatchOperation, parsePatch } from '@humanlayer/agentlayer-core/utils'
import { expandPath } from '../utils/expand-path'
export interface LineRange {
	startLine: number
	endLine: number
}

export interface WastedReadTracking {
	hash: string
	totalLines: number
	ranges: LineRange[]
}

export interface FileReadStateEntry {
	lastReadHash?: string
	wastedRead?: WastedReadTracking
}

export interface FileVerificationStateEntry {
	lastVerifiedHash?: string
}

export type FileReadStateMap = Record<string, FileReadStateEntry>
export type FileVerificationStateMap = Record<string, FileVerificationStateEntry>

export const FILE_READ_STATE_KEY = 'fileReadState'
export const FILE_VERIFICATION_STATE_KEY = 'fileVerificationState'

export interface FileStateHookOptions {
	cwd?: string
}

export interface FileStateHookPair {
	preToolUseHook: PreToolUseHook
	postToolUseHook: PostToolUseHook
}

const DEFAULT_READ_OFFSET = 1
const DEFAULT_READ_LIMIT = 2000

type TrackedPath = {
	resolvedPath: string
	displayPath: string
}

type ResolvedWriteTarget = TrackedPath & {
	exists: boolean
	currentHash?: string
	tracked?: FileVerificationStateEntry
}

type FileReadStateAction =
	| {
			kind: 'setReadObservation'
			path: string
			hash: string
			totalLines: number
			readRange: LineRange
	  }
	| {
			kind: 'delete'
			path: string
	  }
	| {
			kind: 'move'
			from: string
			to: string
			targetHash?: string
	  }

type FileVerificationStateAction =
	| {
			kind: 'setVerified'
			path: string
			hash: string
	  }
	| {
			kind: 'delete'
			path: string
	  }
	| {
			kind: 'move'
			from: string
			to: string
			targetHash?: string
	  }

function hashContent(content: string): string {
	return createHash('sha256').update(content).digest('hex')
}

function wrapSystemReminder(message: string): string {
	return `<system-reminder>${message}</system-reminder>`
}

function getTotalLines(content: string): number {
	if (content.length === 0) {
		return 1
	}

	const split = content.split('\n')
	if (content.endsWith('\n')) {
		return Math.max(1, split.length - 1)
	}

	return split.length
}

function resolveTrackedPath(filePath: string, cwd?: string): string {
	return expandPath(filePath, cwd)
}

function isMissingPathError(error: unknown): boolean {
	const err = error as NodeJS.ErrnoException
	return err.code === 'ENOENT' || err.code === 'ENOTDIR'
}

async function statIfExists(resolvedPath: string) {
	try {
		return await stat(resolvedPath)
	} catch (error) {
		if (isMissingPathError(error)) {
			return undefined
		}
		throw error
	}
}

async function readRegularFile(resolvedPath: string): Promise<string | undefined> {
	const fileStat = await statIfExists(resolvedPath)
	if (!fileStat?.isFile()) {
		return undefined
	}

	return await readFile(resolvedPath, 'utf8')
}

function extractFilePath(input: Record<string, unknown>): string | undefined {
	const path = input.file_path ?? input.filePath
	return typeof path === 'string' ? path : undefined
}

function extractPatchText(input: Record<string, unknown>): string | undefined {
	const patchText = input.patch_text
	return typeof patchText === 'string' ? patchText : undefined
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return fallback
	}

	const normalized = Math.trunc(value)
	return normalized >= 1 ? normalized : fallback
}

function getReadRange(input: Record<string, unknown>): LineRange {
	const offset = normalizePositiveInteger(input.offset, DEFAULT_READ_OFFSET)
	const limit = normalizePositiveInteger(input.limit, DEFAULT_READ_LIMIT)
	return {
		startLine: offset,
		endLine: offset + limit - 1,
	}
}

function mergeLineRanges(ranges: LineRange[]): LineRange[] {
	if (ranges.length <= 1) {
		return ranges
	}

	const sorted = [...ranges].sort((left, right) => left.startLine - right.startLine)
	const merged: LineRange[] = [sorted[0]!]

	for (const range of sorted.slice(1)) {
		const last = merged[merged.length - 1]!
		if (range.startLine <= last.endLine + 1) {
			last.endLine = Math.max(last.endLine, range.endLine)
			continue
		}
		merged.push({ ...range })
	}

	return merged
}

function addCoveredRange(ranges: LineRange[], nextRange: LineRange): LineRange[] {
	return mergeLineRanges([...ranges.map((range) => ({ ...range })), { ...nextRange }])
}

function isRangeCovered(ranges: LineRange[], requestedRange: LineRange): boolean {
	for (const range of ranges) {
		if (range.startLine <= requestedRange.startLine && range.endLine >= requestedRange.endLine) {
			return true
		}
	}
	return false
}

async function computeFileHash(resolvedPath: string): Promise<string | undefined> {
	const text = await readRegularFile(resolvedPath)
	if (text === undefined) {
		return undefined
	}

	return hashContent(text)
}

async function computeFileSnapshot(resolvedPath: string): Promise<{ hash: string; totalLines: number } | undefined> {
	const text = await readRegularFile(resolvedPath)
	if (text === undefined) {
		return undefined
	}

	return {
		hash: hashContent(text),
		totalLines: getTotalLines(text),
	}
}

function parsePatchSafely(patchText: string): PatchOperation[] | undefined {
	try {
		return parsePatch(patchText)
	} catch {
		return undefined
	}
}

function dedupeTrackedPaths(targets: TrackedPath[]): TrackedPath[] {
	const seen = new Set<string>()
	const deduped: TrackedPath[] = []

	for (const target of targets) {
		if (seen.has(target.resolvedPath)) {
			continue
		}
		seen.add(target.resolvedPath)
		deduped.push(target)
	}

	return deduped
}

function getPatchWriteTargets(patchText: string, cwd?: string): TrackedPath[] {
	const operations = parsePatchSafely(patchText)
	if (!operations) {
		return []
	}

	const targets: TrackedPath[] = []

	for (const operation of operations) {
		if (operation.type === 'move') {
			targets.push({
				resolvedPath: resolveTrackedPath(operation.filePath, cwd),
				displayPath: operation.filePath,
			})
			if (operation.targetPath) {
				targets.push({
					resolvedPath: resolveTrackedPath(operation.targetPath, cwd),
					displayPath: operation.targetPath,
				})
			}
			continue
		}

		targets.push({
			resolvedPath: resolveTrackedPath(operation.filePath, cwd),
			displayPath: operation.filePath,
		})
	}

	return dedupeTrackedPaths(targets)
}

function getWritePathTargets(toolName: string, input: Record<string, unknown>, cwd?: string): TrackedPath[] {
	if (toolName === 'apply_patch') {
		const patchText = extractPatchText(input)
		if (!patchText) {
			return []
		}
		return getPatchWriteTargets(patchText, cwd)
	}

	const filePath = extractFilePath(input)
	if (!filePath) {
		return []
	}

	return [
		{
			resolvedPath: resolveTrackedPath(filePath, cwd),
			displayPath: filePath,
		},
	]
}

async function resolveWriteTargets(
	toolName: string,
	input: Record<string, unknown>,
	verificationState: FileVerificationStateMap,
	cwd?: string,
): Promise<ResolvedWriteTarget[]> {
	const targets = getWritePathTargets(toolName, input, cwd)
	const resolvedTargets: ResolvedWriteTarget[] = []

	for (const target of targets) {
		const fileStat = await statIfExists(target.resolvedPath)
		const exists = fileStat !== undefined
		const currentHash = exists ? await computeFileHash(target.resolvedPath) : undefined
		resolvedTargets.push({
			...target,
			exists,
			currentHash,
			tracked: verificationState[target.resolvedPath],
		})
	}

	return resolvedTargets
}

function applyFileReadStateActions(
	current: FileReadStateMap | undefined,
	actions: FileReadStateAction[],
): FileReadStateMap {
	const next: FileReadStateMap = { ...(current ?? {}) }

	for (const action of actions) {
		if (action.kind === 'setReadObservation') {
			const existing = next[action.path]
			const previousRanges = existing?.wastedRead?.hash === action.hash ? existing.wastedRead.ranges : []
			const mergedRanges = addCoveredRange(previousRanges, action.readRange)
			next[action.path] = {
				lastReadHash: action.hash,
				wastedRead: {
					hash: action.hash,
					totalLines: action.totalLines,
					ranges: mergedRanges,
				},
			}
			continue
		}

		if (action.kind === 'delete') {
			delete next[action.path]
			continue
		}

		const sourceEntry = next[action.from]
		delete next[action.from]
		if (!action.targetHash || sourceEntry?.lastReadHash !== action.targetHash) {
			continue
		}
		next[action.to] = {
			lastReadHash: sourceEntry.lastReadHash,
			...(sourceEntry.wastedRead?.hash === action.targetHash ? { wastedRead: sourceEntry.wastedRead } : {}),
		}
	}

	return next
}

function applyFileVerificationStateActions(
	current: FileVerificationStateMap | undefined,
	actions: FileVerificationStateAction[],
): FileVerificationStateMap {
	const next: FileVerificationStateMap = { ...(current ?? {}) }

	for (const action of actions) {
		if (action.kind === 'setVerified') {
			next[action.path] = { lastVerifiedHash: action.hash }
			continue
		}

		if (action.kind === 'delete') {
			delete next[action.path]
			continue
		}

		delete next[action.from]
		if (action.targetHash) {
			next[action.to] = { lastVerifiedHash: action.targetHash }
		}
	}

	return next
}

export function createWastedReadHook(opts?: FileStateHookOptions): PreToolUseHook {
	return createPreToolUseHook(ReadTool, async (ctx) => {
		const readInput = ctx.input as Record<string, unknown>
		const readPath = extractFilePath(readInput)
		if (!readPath) {
			return ctx.next()
		}

		const resolvedPath = resolveTrackedPath(readPath, opts?.cwd)
		const readState = ctx.getState<FileReadStateMap>(FILE_READ_STATE_KEY) ?? {}
		const tracked = readState[resolvedPath]
		if (!tracked?.lastReadHash) {
			return ctx.next()
		}

		const currentHash = await computeFileHash(resolvedPath)
		if (!currentHash || currentHash !== tracked.lastReadHash) {
			return ctx.next()
		}

		const wastedRead = tracked.wastedRead
		if (!wastedRead || wastedRead.hash !== currentHash) {
			return ctx.next()
		}

		const requestedRange = getReadRange(readInput)
		if (!isRangeCovered(wastedRead.ranges, requestedRange)) {
			return ctx.next()
		}

		return ctx.toolResult(
			wrapSystemReminder(
				`File ${readPath} is already in your context and unchanged. Refer to the previous read result.`,
			),
		)
	})
}

export function createWastedReadHooks(opts?: FileStateHookOptions): FileStateHookPair {
	return {
		preToolUseHook: createWastedReadHook(opts),
		postToolUseHook: createFileStateTrackingHook(opts),
	}
}

export function createReadBeforeWriteHook(opts?: FileStateHookOptions): PreToolUseHook {
	return createPreToolUseHook([WriteTool, EditTool, ApplyPatchTool], async (ctx) => {
		const verificationState = ctx.getState<FileVerificationStateMap>(FILE_VERIFICATION_STATE_KEY) ?? {}
		const targets = await resolveWriteTargets(
			ctx.toolName,
			ctx.input as Record<string, unknown>,
			verificationState,
			opts?.cwd,
		)

		for (const target of targets) {
			if (!target.exists) {
				continue
			}

			if (!target.tracked?.lastVerifiedHash || target.currentHash !== target.tracked.lastVerifiedHash) {
				return ctx.toolResult(
					wrapSystemReminder(`You must read file ${target.displayPath} before writing to it.`),
					{
						isError: true,
					},
				)
			}
		}

		return ctx.next()
	})
}

export function createReadBeforeWriteHooks(opts?: FileStateHookOptions): FileStateHookPair {
	return {
		preToolUseHook: createReadBeforeWriteHook(opts),
		postToolUseHook: createFileStateTrackingHook(opts),
	}
}

export function createFileStateTrackingHook(opts?: FileStateHookOptions): PostToolUseHook {
	return createPostToolUseHook([ReadTool, WriteTool, EditTool, ApplyPatchTool], async (ctx) => {
		if (ctx.toolName === 'read') {
			const readInput = ctx.input as Record<string, unknown>
			const readPath = extractFilePath(readInput)
			if (!readPath) {
				return ctx.done()
			}

			const resolvedPath = resolveTrackedPath(readPath, opts?.cwd)
			const snapshot =
				typeof ctx.rawOutput === 'string'
					? {
							hash: hashContent(ctx.rawOutput),
							totalLines: getTotalLines(ctx.rawOutput),
						}
					: await computeFileSnapshot(resolvedPath)
			if (!snapshot) {
				return ctx.done()
			}

			const readRange = getReadRange(readInput)
			ctx.updateState<FileReadStateMap>(FILE_READ_STATE_KEY, (current) =>
				applyFileReadStateActions(current, [
					{
						kind: 'setReadObservation',
						path: resolvedPath,
						hash: snapshot.hash,
						totalLines: snapshot.totalLines,
						readRange,
					},
				]),
			)
			ctx.updateState<FileVerificationStateMap>(FILE_VERIFICATION_STATE_KEY, (current) =>
				applyFileVerificationStateActions(current, [
					{ kind: 'setVerified', path: resolvedPath, hash: snapshot.hash },
				]),
			)
			return ctx.done()
		}

		if (ctx.toolName === 'write' || ctx.toolName === 'edit') {
			const filePath = extractFilePath(ctx.input as Record<string, unknown>)
			if (!filePath) {
				return ctx.done()
			}

			const resolvedPath = resolveTrackedPath(filePath, opts?.cwd)
			const hash = await computeFileHash(resolvedPath)
			if (!hash) {
				return ctx.done()
			}

			ctx.updateState<FileVerificationStateMap>(FILE_VERIFICATION_STATE_KEY, (current) =>
				applyFileVerificationStateActions(current, [{ kind: 'setVerified', path: resolvedPath, hash }]),
			)
			return ctx.done()
		}

		if (ctx.toolName !== 'apply_patch') {
			return ctx.done()
		}

		const patchText = extractPatchText(ctx.input as Record<string, unknown>)
		if (!patchText) {
			return ctx.done()
		}

		const operations = parsePatchSafely(patchText)
		if (!operations) {
			return ctx.done()
		}

		const readActions: FileReadStateAction[] = []
		const verificationActions: FileVerificationStateAction[] = []
		for (const operation of operations) {
			if (operation.type === 'delete') {
				const path = resolveTrackedPath(operation.filePath, opts?.cwd)
				readActions.push({ kind: 'delete', path })
				verificationActions.push({ kind: 'delete', path })
				continue
			}

			if (operation.type === 'move') {
				if (!operation.targetPath) {
					continue
				}
				const to = resolveTrackedPath(operation.targetPath, opts?.cwd)
				const targetHash = await computeFileHash(to)
				const action = {
					kind: 'move',
					from: resolveTrackedPath(operation.filePath, opts?.cwd),
					to,
					targetHash,
				} as const
				readActions.push(action)
				verificationActions.push(action)
				continue
			}

			const resolvedPath = resolveTrackedPath(operation.filePath, opts?.cwd)
			const hash = await computeFileHash(resolvedPath)
			if (!hash) {
				continue
			}
			verificationActions.push({ kind: 'setVerified', path: resolvedPath, hash })
		}

		if (readActions.length > 0) {
			ctx.updateState<FileReadStateMap>(FILE_READ_STATE_KEY, (current) =>
				applyFileReadStateActions(current, readActions),
			)
		}

		if (verificationActions.length > 0) {
			ctx.updateState<FileVerificationStateMap>(FILE_VERIFICATION_STATE_KEY, (current) =>
				applyFileVerificationStateActions(current, verificationActions),
			)
		}

		return ctx.done()
	})
}
