import type { YjsFilesystem } from '@humanlayer/yjs-fs'

export type FilesystemSnapshot = DirectorySnapshot

type DirectorySnapshot = {
	type: 'directory'
	entryId: string
	children: Record<string, DirectorySnapshot | FileSnapshot>
}

type FileSnapshot = {
	type: 'file'
	entryId: string
	contentId?: string
	size?: number
	content: string
}

export function snapshotFilesystem(filesystem: YjsFilesystem): FilesystemSnapshot {
	return snapshotDirectory(filesystem, '/')
}

function snapshotDirectory(filesystem: YjsFilesystem, path: string): DirectorySnapshot {
	const stat = filesystem.stat(path)
	const children: Record<string, DirectorySnapshot | FileSnapshot> = {}

	for (const entry of filesystem.list(path)) {
		children[entry.name] =
			entry.type === 'directory'
				? snapshotDirectory(filesystem, entry.path)
				: snapshotFile(filesystem, entry.path)
	}

	return {
		type: 'directory',
		entryId: stat.entryId,
		children,
	}
}

function snapshotFile(filesystem: YjsFilesystem, path: string): FileSnapshot {
	const stat = filesystem.stat(path)

	return {
		type: 'file',
		entryId: stat.entryId,
		contentId: stat.contentId,
		size: stat.size,
		content: filesystem.readFile(path),
	}
}
