import type { Awareness } from 'y-protocols/awareness'

export interface FileMetadata {
	contentStreamId: string // subdoc GUID
	size: number
	createdAt: number
	modifiedAt: number
}

export interface FileStat {
	size: number
	createdAt: number
	modifiedAt: number
}

export interface Entry {
	name: string
	type: 'file' | 'directory'
}

export interface GrepMatch {
	file: string
	line: number
	content: string
}

export interface GrepOptions {
	include?: string // glob filter for files
}

export interface StreamFSConnectOptions {
	baseUrl: string
	prefix: string
	headers?: Record<string, string>
	transport?: 'sse' | 'long-poll'
	awareness?: Awareness
}

export interface CommentData {
	id: string
	author: string
	body: string
	createdAt: number
	anchorStart: Uint8Array // serialized Y.RelativePosition
	anchorEnd: Uint8Array // serialized Y.RelativePosition
	resolved?: boolean
	resolvedAt?: number
	resolvedBy?: string
}

export interface CommentReply {
	id: string
	parentId: string
	author: string
	body: string
	createdAt: number
}

export interface Comment {
	id: string
	author: string
	body: string
	createdAt: number
	anchorIndex: number
	anchorLength: number
	replies: CommentReply[]
	resolved: boolean
	resolvedAt?: number
	resolvedBy?: string
}

export interface EditResult {
	path: string
	editIndex: number
	editLine: number
	affectedLines: { start: number; end: number }
}

export class FileNotFoundError extends Error {
	constructor(path: string) {
		super(`File not found: ${path}`)
		this.name = 'FileNotFoundError'
	}
}

export class FileExistsError extends Error {
	constructor(path: string) {
		super(`File already exists: ${path}`)
		this.name = 'FileExistsError'
	}
}
