import type { ArtifactMetadata } from '@humanlayer/yjs-rich-markdown'
import { useEffect, useState } from 'react'
import { useArtifactSession } from '../providers/ArtifactProvider'

type ArtifactListProps = {
	onSelect?: (path: string) => void
	selectedPath?: string
}

export function ArtifactList({ onSelect, selectedPath }: ArtifactListProps) {
	const { store } = useArtifactSession()
	const [artifacts, setArtifacts] = useState<ArtifactMetadata[]>([])

	useEffect(() => {
		const update = () => {
			setArtifacts(store.listArtifacts())
		}

		update()
		store.registry.observe(update)
		return () => store.registry.unobserve(update)
	}, [store])

	return (
		<div style={{ padding: 8 }}>
			<h4 style={{ margin: '0 0 8px' }}>Artifacts ({artifacts.length})</h4>
			{artifacts.length === 0 ? (
				<div style={{ color: '#666', fontSize: 14 }}>No artifacts yet</div>
			) : (
				<ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
					{artifacts.map((artifact) => (
						<li
							key={artifact.path}
							onClick={() => onSelect?.(artifact.path)}
							style={{
								padding: '6px 8px',
								cursor: 'pointer',
								background: selectedPath === artifact.path ? '#e3f2fd' : 'transparent',
								borderRadius: 4,
								marginBottom: 2,
								fontSize: 14,
							}}
						>
							{artifact.path}
							{artifact.title && <span style={{ color: '#666', marginLeft: 8 }}>({artifact.title})</span>}
						</li>
					))}
				</ul>
			)}
		</div>
	)
}
