import { useEffect, useState } from 'react'
import { type Collaborator, getCollaborators } from '../lib/collaboration'
import { useArtifactSession } from '../providers/ArtifactProvider'

type AwarenessDebugPanelProps = {
	filterByArtifact?: string
}

export function AwarenessDebugPanel({ filterByArtifact }: AwarenessDebugPanelProps) {
	const { awareness } = useArtifactSession()
	const [states, setStates] = useState<Map<number, unknown>>(new Map())
	const [collaborators, setCollaborators] = useState<Collaborator[]>([])

	useEffect(() => {
		const update = () => {
			const newStates = new Map(awareness.getStates())
			setStates(newStates)
			setCollaborators(
				getCollaborators(newStates, awareness.clientID, {
					includeSelf: true,
					filterByArtifact,
				}),
			)
		}

		update()
		awareness.on('change', update)
		return () => awareness.off('change', update)
	}, [awareness, filterByArtifact])

	return (
		<div
			style={{
				padding: 12,
				background: '#f5f5f5',
				borderRadius: 4,
				fontSize: 12,
				fontFamily: 'monospace',
				overflow: 'auto',
			}}
		>
			<h4 style={{ margin: '0 0 8px' }}>
				Awareness Debug {filterByArtifact ? `(filtered: ${filterByArtifact})` : '(all)'}
			</h4>
			<div style={{ marginBottom: 12 }}>
				<strong>Local Client ID:</strong> {awareness.clientID}
			</div>

			<div style={{ marginBottom: 12 }}>
				<strong>Collaborators ({collaborators.length}):</strong>
				{collaborators.map((c) => (
					<div
						key={c.clientId}
						style={{
							marginTop: 4,
							padding: 4,
							background: c.isSelf ? '#e3f2fd' : '#fff',
							borderRadius: 2,
							borderLeft: `3px solid ${c.user.color}`,
						}}
					>
						<div>
							{c.user.name} {c.isSelf ? '(you)' : ''}
						</div>
						<div style={{ color: '#666' }}>
							clientId: {c.clientId}, path: {c.presence.artifactPath ?? 'none'}
						</div>
					</div>
				))}
			</div>

			<details>
				<summary style={{ cursor: 'pointer', marginBottom: 8 }}>
					<strong>Raw States ({states.size})</strong>
				</summary>
				<pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0 }}>
					{JSON.stringify(Array.from(states.entries()), null, 2)}
				</pre>
			</details>
		</div>
	)
}
