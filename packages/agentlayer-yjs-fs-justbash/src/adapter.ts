import { isAbsolute, join, normalize, resolve } from 'node:path/posix'
import type { EntryStat, YjsFilesystem } from '@humanlayer/yjs-fs'
import type { BufferEncoding, CpOptions, FileContent, FsStat, IFileSystem, MkdirOptions, RmOptions } from 'just-bash'

type ReadFileOptions = { encoding?: BufferEncoding | null }
type WriteFileOptions = { encoding?: BufferEncoding }
type DirentEntry = { name: string; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean }

function createError(code: string, message: string, path?: string): Error & { code: string; path?: string } {
	const error = new Error(message) as Error & { code: string; path?: string }
	error.code = code
	if (path) error.path = path
	return error
}

function unsupported(operation: string): Error {
	return createError('ENOTSUP', `${operation} is not supported by YjsFilesystem`)
}

function contentToString(content: FileContent): string {
	return typeof content === 'string' ? content : new TextDecoder().decode(content)
}

function toUint8Array(content: string): Uint8Array {
	return new TextEncoder().encode(content)
}

function mapStat(stat: EntryStat): FsStat {
	return {
		isFile: stat.isFile,
		isDirectory: stat.isDirectory,
		isSymbolicLink: false,
		mode: stat.isDirectory ? 0o755 : 0o644,
		size: stat.size ?? 0,
		mtime: new Date(stat.modifiedAt),
	}
}

function normalizeYjsPath(path: string): string {
	const normalized = normalize(path)
	return normalized.startsWith('/') ? normalized : `/${normalized}`
}

export class YjsFsBashAdapter implements IFileSystem {
	constructor(private readonly fs: YjsFilesystem) {}

	async readFile(path: string, options?: ReadFileOptions | BufferEncoding): Promise<string> {
		const encoding = typeof options === 'string' ? options : options?.encoding
		if (encoding === null) {
			return new TextDecoder().decode(this.fs.readBinaryFile(path))
		}
		return this.fs.readFile(path)
	}

	async readFileBuffer(path: string): Promise<Uint8Array> {
		try {
			return this.fs.readBinaryFile(path)
		} catch {
			return toUint8Array(this.fs.readFile(path))
		}
	}

	async writeFile(path: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void> {
		const encoding = typeof options === 'string' ? options : options?.encoding
		if (content instanceof Uint8Array && encoding !== 'utf8' && encoding !== 'utf-8') {
			if (this.fs.exists(path)) {
				this.fs.writeBinaryFile(path, content)
			} else {
				this.fs.createBinaryFile(path, content)
			}
			return
		}

		const text = contentToString(content)
		if (this.fs.exists(path)) {
			this.fs.writeFile(path, text)
		} else {
			this.fs.createFile(path, text)
		}
	}

	async appendFile(path: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void> {
		const existing = this.fs.exists(path) ? this.fs.readFile(path) : ''
		await this.writeFile(path, existing + contentToString(content), options)
	}

	async exists(path: string): Promise<boolean> {
		return this.fs.exists(path)
	}

	async stat(path: string): Promise<FsStat> {
		return mapStat(this.fs.stat(path))
	}

	async mkdir(path: string, options?: MkdirOptions): Promise<void> {
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

	async readdir(path: string): Promise<string[]> {
		return this.fs.list(path).map((entry) => entry.name)
	}

	async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
		return this.fs.list(path).map((entry) => ({
			name: entry.name,
			isFile: entry.type === 'file',
			isDirectory: entry.type === 'directory',
			isSymbolicLink: false,
		}))
	}

	async rm(path: string, options?: RmOptions): Promise<void> {
		if (!this.fs.exists(path)) {
			if (options?.force) return
			throw createError('ENOENT', `No such file or directory: ${path}`, path)
		}
		this.fs.unlink(path)
	}

	async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
		const stat = this.fs.stat(src)
		if (stat.isDirectory) {
			if (!options?.recursive)
				throw createError('EISDIR', `Cannot copy directory without recursive option: ${src}`, src)
			if (!this.fs.exists(dest)) this.fs.mkdir(dest)
			for (const entry of this.fs.list(src)) {
				await this.cp(entry.path, join(dest, entry.name), options)
			}
			return
		}

		if (stat.encoding === 'binary') {
			await this.writeFile(dest, this.fs.readBinaryFile(src))
		} else {
			await this.writeFile(dest, this.fs.readFile(src))
		}
	}

	async mv(src: string, dest: string): Promise<void> {
		this.fs.rename(src, dest)
	}

	resolvePath(base: string, path: string): string {
		return normalizeYjsPath(isAbsolute(path) ? path : resolve(base || '/', path))
	}

	getAllPaths(): string[] {
		const paths: string[] = []
		const walk = (path: string) => {
			for (const entry of this.fs.list(path)) {
				paths.push(entry.path)
				if (entry.type === 'directory') walk(entry.path)
			}
		}
		walk('/')
		return paths.sort()
	}

	async chmod(path: string, mode: number): Promise<void> {
		throw unsupported('chmod')
	}

	async symlink(target: string, linkPath: string): Promise<void> {
		throw unsupported('symlink')
	}

	async link(existingPath: string, newPath: string): Promise<void> {
		throw unsupported('link')
	}

	async readlink(path: string): Promise<string> {
		throw unsupported('readlink')
	}

	async lstat(path: string): Promise<FsStat> {
		return this.stat(path)
	}

	async realpath(path: string): Promise<string> {
		if (!this.fs.exists(path)) throw createError('ENOENT', `No such file or directory: ${path}`, path)
		return normalizeYjsPath(path)
	}

	async utimes(path: string, atime: Date, mtime: Date): Promise<void> {
		if (!this.fs.exists(path)) throw createError('ENOENT', `No such file or directory: ${path}`, path)
	}
}
