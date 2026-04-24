import { useFilesystem, useFilesystemTree } from '@humanlayer/yjs-fs-react'
import { FileTree, useFileTree, useFileTreeSelection } from '@pierre/trees/react'
import { useCallback, useEffect, useState } from 'react'

type FileTreePaneProps = {
	activePath: string
	onFileSelect: (path: string) => void
}

function flattenTreePaths(node: { path: string; children?: Array<{ path: string; children?: any[] }> }): string[] {
	const paths: string[] = []
	for (const child of node.children ?? []) {
		paths.push(child.path)
		paths.push(...flattenTreePaths(child))
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
		initialExpandedPaths: ['/'],
		renaming: {
			canRename: (item) => item.path !== '/',
			onRename: ({ sourcePath, destinationPath }) => {
				try {
					filesystem.rename(sourcePath, destinationPath)
				} catch (err) {
					console.error('Failed to rename:', err)
				}
			},
		},
		dragAndDrop: {
			canDrag: (draggedPaths) => !draggedPaths.includes('/'),
			canDrop: ({ target }) => target.directoryPath !== undefined,
			onDropComplete: ({ draggedPaths, target }) => {
				const targetDir = target.directoryPath || '/'
				for (const sourcePath of draggedPaths) {
					const name = sourcePath.split('/').pop() || ''
					const destPath = targetDir === '/' ? `/${name}` : `${targetDir}/${name}`
					try {
						filesystem.rename(sourcePath, destPath)
					} catch (err) {
						console.error('Failed to move:', err)
					}
				}
			},
		},
		onSelectionChange: (selectedPaths) => {
			if (selectedPaths.length === 1) {
				const path = selectedPaths[0]
				try {
					const stat = filesystem.stat(path)
					if (stat.isFile) {
						onFileSelect(path)
					}
				} catch (err: unknown) {
					// Path doesn't exist
					console.error('Error: path does not exist', err)
				}
			}
		},
	})

	// Observe Y.js catalog for changes and update tree
	useEffect(() => {
		const paths = flattenTreePaths(tree)
		model.resetPaths(paths)
	}, [tree, model])

	const selectedPaths = useFileTreeSelection(model)

	const handleNewFile = useCallback(() => {
		const parent =
			selectedPaths.length === 1
				? (() => {
						try {
							const stat = filesystem.stat(selectedPaths[0])
							return stat.isDirectory
								? selectedPaths[0]
								: selectedPaths[0].split('/').slice(0, -1).join('/') || '/'
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
						try {
							const stat = filesystem.stat(selectedPaths[0])
							return stat.isDirectory
								? selectedPaths[0]
								: selectedPaths[0].split('/').slice(0, -1).join('/') || '/'
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
		const path = selectedPaths[0]
		if (path === '/') return

		if (confirm(`Delete ${path}?`)) {
			try {
				filesystem.unlink(path)
			} catch (err) {
				console.error('Failed to delete:', err)
				alert(`Failed to delete: ${err}`)
			}
		}
	}, [selectedPaths, filesystem])

	const handleCreateItem = useCallback(() => {
		if (!newItemName.trim()) return

		const fullPath = newItemParent === '/' ? `/${newItemName}` : `${newItemParent}/${newItemName}`

		try {
			if (newItemType === 'folder') {
				filesystem.mkdir(fullPath)
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
	}, [newItemType, newItemName, newItemParent, filesystem, onFileSelect])

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
					disabled={selectedPaths.length === 0 || selectedPaths[0] === '/'}
					style={{
						padding: '4px 8px',
						fontSize: '12px',
						border: '1px solid #ccc',
						borderRadius: '4px',
						backgroundColor: 'white',
						cursor: selectedPaths.length === 0 || selectedPaths[0] === '/' ? 'not-allowed' : 'pointer',
						opacity: selectedPaths.length === 0 || selectedPaths[0] === '/' ? 0.5 : 1,
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
							placeholder={newItemType === 'folder' ? 'folder-name' : 'file.ts'}
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
