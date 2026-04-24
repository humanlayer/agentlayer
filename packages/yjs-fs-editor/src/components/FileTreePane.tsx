import { useFilesystem, useFilesystemTree } from '@humanlayer/yjs-fs-react'
import { FileTree, useFileTree, useFileTreeSelection } from '@pierre/trees/react'
import { useCallback, useEffect, useState } from 'react'

type FileTreePaneProps = {
	activePath: string
	onFileSelect: (path: string) => void
}

// Convert filesystem path (with leading /) to Trees path (without leading /)
function toTreePath(fsPath: string): string {
	return fsPath.startsWith('/') ? fsPath.slice(1) : fsPath
}

// Convert Trees path back to filesystem path
function toFsPath(treePath: string): string {
	return treePath.startsWith('/') ? treePath : `/${treePath}`
}

function flattenFilePaths(node: {
	path: string
	type: 'file' | 'directory'
	children?: Array<{ path: string; type: 'file' | 'directory'; children?: any[] }>
}): string[] {
	const paths: string[] = []
	for (const child of node.children ?? []) {
		if (child.type === 'file') {
			paths.push(toTreePath(child.path))
		}
		paths.push(...flattenFilePaths(child))
	}
	return paths
}

export function FileTreePane({ onFileSelect }: FileTreePaneProps) {
	const filesystem = useFilesystem()
	const tree = useFilesystemTree('/')

	const [newItemType, setNewItemType] = useState<'file' | 'folder' | null>(null)
	const [newItemName, setNewItemName] = useState('')
	const [newItemParent, setNewItemParent] = useState('/')

	const { model } = useFileTree({
		paths: [],
		search: true,
		icons: { set: 'complete', colored: true },
		renaming: {
			canRename: () => true,
			onRename: ({ sourcePath, destinationPath }) => {
				try {
					filesystem.rename(toFsPath(sourcePath), toFsPath(destinationPath))
				} catch (err) {
					console.error('Failed to rename:', err)
				}
			},
		},
		dragAndDrop: {
			canDrag: () => true,
			canDrop: ({ target }) => target.directoryPath !== undefined,
			onDropComplete: ({ draggedPaths, target }) => {
				const targetDir = target.directoryPath ?? ''
				for (const sourcePath of draggedPaths) {
					const name = sourcePath.split('/').pop() || ''
					const destPath = targetDir ? `${targetDir}/${name}` : name
					try {
						filesystem.rename(toFsPath(sourcePath), toFsPath(destPath))
					} catch (err) {
						console.error('Failed to move:', err)
					}
				}
			},
		},
		onSelectionChange: (selectedPaths) => {
			if (selectedPaths.length === 1) {
				const fsPath = toFsPath(selectedPaths[0])
				try {
					const stat = filesystem.stat(fsPath)
					if (stat.isFile) {
						onFileSelect(fsPath)
					}
				} catch (err: unknown) {
					console.error('Error: path does not exist', err)
				}
			}
		},
	})

	// Observe Y.js catalog for changes and update tree
	// Trees auto-generates directories from file paths, so only pass files
	useEffect(() => {
		const paths = flattenFilePaths(tree)
		model.resetPaths(paths)
	}, [tree, model])

	const selectedPaths = useFileTreeSelection(model)

	const handleNewFile = useCallback(() => {
		const parent =
			selectedPaths.length === 1
				? (() => {
						const fsPath = toFsPath(selectedPaths[0])
						try {
							const stat = filesystem.stat(fsPath)
							return stat.isDirectory ? fsPath : fsPath.split('/').slice(0, -1).join('/') || '/'
						} catch {
							return '/'
						}
					})()
				: '/'
		setNewItemParent(parent)
		setNewItemType('file')
		setNewItemName('')
	}, [selectedPaths, filesystem])

	const handleNewFolder = useCallback(() => {
		const parent =
			selectedPaths.length === 1
				? (() => {
						const fsPath = toFsPath(selectedPaths[0])
						try {
							const stat = filesystem.stat(fsPath)
							return stat.isDirectory ? fsPath : fsPath.split('/').slice(0, -1).join('/') || '/'
						} catch {
							return '/'
						}
					})()
				: '/'
		setNewItemParent(parent)
		setNewItemType('folder')
		setNewItemName('')
	}, [selectedPaths, filesystem])

	const handleDelete = useCallback(() => {
		if (selectedPaths.length === 0) return
		const fsPath = toFsPath(selectedPaths[0])

		if (confirm(`Delete ${fsPath}?`)) {
			try {
				filesystem.unlink(fsPath)
			} catch (err) {
				console.error('Failed to delete:', err)
				alert(`Failed to delete: ${err}`)
			}
		}
	}, [selectedPaths, filesystem])

	const ensureParentDirectories = useCallback(
		(path: string) => {
			const parts = path.split('/').filter(Boolean)
			parts.pop()
			let current = ''
			for (const part of parts) {
				current = `${current}/${part}`
				try {
					const stat = filesystem.stat(current)
					if (!stat.isDirectory) {
						throw new Error(`${current} exists but is not a directory`)
					}
				} catch {
					filesystem.mkdir(current)
				}
			}
		},
		[filesystem],
	)

	const handleCreateItem = useCallback(() => {
		if (!newItemName.trim()) return

		const fullPath = newItemParent === '/' ? `/${newItemName}` : `${newItemParent}/${newItemName}`

		try {
			ensureParentDirectories(fullPath)
			if (newItemType === 'folder') {
				// Create .gitkeep so the folder shows up (Trees infers dirs from file paths)
				const gitkeepPath = `${fullPath}/.gitkeep`
				ensureParentDirectories(gitkeepPath)
				filesystem.createFile(gitkeepPath, '')
			} else {
				filesystem.createFile(fullPath, '')
				onFileSelect(fullPath)
			}
			setNewItemType(null)
			setNewItemName('')
		} catch (err) {
			console.error('Failed to create:', err)
			alert(`Failed to create: ${err}`)
		}
	}, [newItemType, newItemName, newItemParent, filesystem, onFileSelect, ensureParentDirectories])

	return (
		<div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
			<div
				style={{
					display: 'flex',
					gap: '4px',
					padding: '8px',
					borderBottom: '1px solid #e0e0e0',
				}}
			>
				<button
					onClick={handleNewFile}
					style={{
						padding: '4px 8px',
						fontSize: '12px',
						border: '1px solid #ccc',
						borderRadius: '4px',
						backgroundColor: 'white',
						cursor: 'pointer',
					}}
					title="New File"
				>
					+ File
				</button>
				<button
					onClick={handleNewFolder}
					style={{
						padding: '4px 8px',
						fontSize: '12px',
						border: '1px solid #ccc',
						borderRadius: '4px',
						backgroundColor: 'white',
						cursor: 'pointer',
					}}
					title="New Folder"
				>
					+ Folder
				</button>
				<button
					onClick={handleDelete}
					disabled={selectedPaths.length === 0}
					style={{
						padding: '4px 8px',
						fontSize: '12px',
						border: '1px solid #ccc',
						borderRadius: '4px',
						backgroundColor: 'white',
						cursor: selectedPaths.length === 0 ? 'not-allowed' : 'pointer',
						opacity: selectedPaths.length === 0 ? 0.5 : 1,
					}}
					title="Delete"
				>
					Delete
				</button>
			</div>

			{newItemType && (
				<div
					style={{
						padding: '8px',
						borderBottom: '1px solid #e0e0e0',
						backgroundColor: '#f5f5f5',
					}}
				>
					<div style={{ fontSize: '12px', marginBottom: '4px', color: '#666' }}>
						New {newItemType} in {newItemParent}
					</div>
					<div style={{ display: 'flex', gap: '4px' }}>
						<input
							type="text"
							value={newItemName}
							onChange={(e) => setNewItemName(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === 'Enter') handleCreateItem()
								if (e.key === 'Escape') setNewItemType(null)
							}}
							placeholder={newItemType === 'folder' ? 'path/to/folder' : 'path/to/file.ts'}
							autoFocus
							style={{
								flex: 1,
								padding: '4px 8px',
								fontSize: '12px',
								border: '1px solid #ccc',
								borderRadius: '4px',
							}}
						/>
						<button
							onClick={handleCreateItem}
							style={{
								padding: '4px 8px',
								fontSize: '12px',
								border: 'none',
								borderRadius: '4px',
								backgroundColor: '#1976d2',
								color: 'white',
								cursor: 'pointer',
							}}
						>
							Create
						</button>
						<button
							onClick={() => setNewItemType(null)}
							style={{
								padding: '4px 8px',
								fontSize: '12px',
								border: '1px solid #ccc',
								borderRadius: '4px',
								backgroundColor: 'white',
								cursor: 'pointer',
							}}
						>
							Cancel
						</button>
					</div>
				</div>
			)}

			<div style={{ flex: 1, overflow: 'auto' }}>
				<FileTree model={model} style={{ height: '100%' }} />
			</div>
		</div>
	)
}
