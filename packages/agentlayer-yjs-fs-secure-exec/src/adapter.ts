import { normalize } from 'node:path/posix'
import type { EntryStat, YjsFilesystem } from '@humanlayer/yjs-fs'
import type { VirtualFileSystem } from 'secure-exec'

type VirtualDirEntry = Awaited<ReturnType<VirtualFileSystem['readDirWithTypes']>>[number]
type VirtualStat = Awaited<ReturnType<VirtualFileSystem['stat']>>

export type YjsFsSecureExecOperationType = 'read' | 'write' | 'list' | 'mkdir' | 'delete' | 'rename' | 'truncate'

export interface YjsFsSecureExecOperation {
	type: YjsFsSecureExecOperationType
	path: string
	toPath?: string
	pathType?: 'file' | 'directory' | 'unknown'
}

type MkdirOptions = { recursive?: boolean }

function createError(code: string, message: string, path?: string): Error & { code: string; path?: string } {
	const error = new Error(message) as Error & { code: string; path?: string }
	error.code = code
	if (path) error.path = path
	return error
}

function unsupported(operation: string): Error {
	return createError('ENOTSUP', `${operation} is not supported by YjsFilesystem`)
}

function normalizeYjsPath(path: string): string {
	const normalized = normalize(path)
	return normalized.startsWith('/') ? normalized : `/${normalized}`
}

function mapStat(stat: EntryStat): VirtualStat {
	const now = stat.modifiedAt ?? Date.now()
	return {
		mode: stat.isDirectory ? 0o755 : 0o644,
		size: stat.size ?? 0,
		isDirectory: stat.isDirectory,
		isSymbolicLink: false,
		atimeMs: now,
		mtimeMs: now,
		ctimeMs: now,
		birthtimeMs: now,
		ino: 0,
		nlink: 1,
		uid: 0,
		gid: 0,
	}
}

function _contentToBytes(content: string | Uint8Array): Uint8Array {
	return typeof content === 'string' ? new TextEncoder().encode(content) : content
}

function _contentToText(content: string | Uint8Array): string {
	return typeof content === 'string' ? content : new TextDecoder().decode(content)
}

export class YjsFsSecureExecAdapter implements VirtualFileSystem {
	private operations: YjsFsSecureExecOperation[] = []

	constructor(private readonly fs: YjsFilesystem) {}

	consumeOperations(): YjsFsSecureExecOperation[] {
		const operations = this.operations
		this.operations = []
		return operations
	}

	private record(operation: YjsFsSecureExecOperation): void {
		this.operations.push(operation)
	}

	async readFile(path: string): Promise<Uint8Array> {
		this.record({ type: 'read', path, pathType: 'file' })
		try {
			return this.fs.readBinaryFile(path)
		} catch {
			return new TextEncoder().encode(this.fs.readFile(path))
		}
	}

	async readTextFile(path: string): Promise<string> {
		this.record({ type: 'read', path, pathType: 'file' })
		return this.fs.readFile(path)
	}

	async writeFile(path: string, content: string | Uint8Array): Promise<void> {
		this.record({ type: 'write', path, pathType: 'file' })
		if (typeof content === 'string') {
			if (this.fs.exists(path)) this.fs.writeFile(path, content)
			else this.fs.createFile(path, content)
			return
		}
		if (this.fs.exists(path)) this.fs.writeBinaryFile(path, content)
		else this.fs.createBinaryFile(path, content)
	}

	async readDir(path: string): Promise<string[]> {
		this.record({ type: 'list', path, pathType: 'directory' })
		return this.fs.list(path).map((entry) => entry.name)
	}

	async readDirWithTypes(path: string): Promise<VirtualDirEntry[]> {
		this.record({ type: 'list', path, pathType: 'directory' })
		return this.fs.list(path).map((entry) => ({
			name: entry.name,
			isDirectory: entry.type === 'directory',
		}))
	}

	async createDir(path: string): Promise<void> {
		await this.mkdir(path)
	}

	async mkdir(path: string, options?: MkdirOptions): Promise<void> {
		this.record({ type: 'mkdir', path, pathType: 'directory' })
		if (options?.recursive) {
			const parts = normalizeYjsPath(path).split('/').filter(Boolean)
			let current = ''
			for (const part of parts) {
				current = `${current}/${part}`
				if (!this.fs.exists(current)) this.fs.mkdir(current)
			}
			return
		}
		this.fs.mkdir(path)
	}

	async exists(path: string): Promise<boolean> {
		return this.fs.exists(path)
	}

	async stat(path: string): Promise<VirtualStat> {
		return mapStat(this.fs.stat(path))
	}

	async lstat(path: string): Promise<VirtualStat> {
		return this.stat(path)
	}

	async removeFile(path: string): Promise<void> {
		this.record({ type: 'delete', path, pathType: 'file' })
		this.fs.unlink(path)
	}

	async removeDir(path: string): Promise<void> {
		this.record({ type: 'delete', path, pathType: 'directory' })
		this.fs.unlink(path)
	}

	async rename(oldPath: string, newPath: string): Promise<void> {
		this.record({
			type: 'rename',
			path: oldPath,
			toPath: newPath,
			pathType: this.fs.exists(oldPath) ? (this.fs.stat(oldPath).isDirectory ? 'directory' : 'file') : 'unknown',
		})
		this.fs.rename(oldPath, newPath)
	}

	async realpath(path: string): Promise<string> {
		if (!this.fs.exists(path)) throw createError('ENOENT', `No such file or directory: ${path}`, path)
		return normalizeYjsPath(path)
	}

	async truncate(path: string, length: number): Promise<void> {
		this.record({ type: 'truncate', path, pathType: 'file' })
		const stat = this.fs.stat(path)
		if (stat.encoding === 'binary') {
			const existing = this.fs.readBinaryFile(path)
			const next = new Uint8Array(length)
			next.set(existing.slice(0, length))
			this.fs.writeBinaryFile(path, next)
			return
		}
		const existing = this.fs.readFile(path)
		this.fs.writeFile(path, existing.slice(0, length))
	}

	async pread(path: string, offset: number, length: number): Promise<Uint8Array> {
		const content = await this.readFile(path)
		return content.slice(offset, offset + length)
	}

	async pwrite(path: string, offset: number, data: Uint8Array): Promise<void> {
		this.record({ type: 'write', path, pathType: 'file' })
		const existing = this.fs.exists(path) ? await this.readFile(path) : new Uint8Array(0)
		const next = new Uint8Array(Math.max(existing.length, offset + data.length))
		next.set(existing)
		next.set(data, offset)
		await this.writeFile(path, next)
	}

	async symlink(target: string, linkPath: string): Promise<void> {
		throw unsupported('symlink')
	}

	async readlink(path: string): Promise<string> {
		throw unsupported('readlink')
	}

	async link(oldPath: string, newPath: string): Promise<void> {
		throw unsupported('link')
	}

	async chmod(path: string, mode: number): Promise<void> {
		throw unsupported('chmod')
	}

	async chown(path: string, uid: number, gid: number): Promise<void> {
		throw unsupported('chown')
	}

	async utimes(path: string, atime: number, mtime: number): Promise<void> {
		if (!this.fs.exists(path)) throw createError('ENOENT', `No such file or directory: ${path}`, path)
	}
}
