import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { AwarenessDebugPanel } from '../components/AwarenessDebugPanel'
import { useArtifactSession } from '../providers/ArtifactProvider'

export const Route = createFileRoute('/awareness')({
	component: AwarenessRoute,
})

function AwarenessRoute() {
	const { awareness, localUser } = useArtifactSession()
	const [simulatedPath, setSimulatedPath] = useState<string>('')
	const [rawState, setRawState] = useState<string>('')

	useEffect(() => {
		const update = () => {
			setRawState(JSON.stringify(awareness.getLocalState(), null, 2))
		}
		update()
		awareness.on('change', update)
		return () => awareness.off('change', update)
	}, [awareness])

	const setPresencePath = (path: string) => {
		setSimulatedPath(path)
		awareness.setLocalStateField('presence', { artifactPath: path || undefined })
	}

	return (
		<div style={{ padding: 24, maxWidth: 1000 }}>
			<h1>Awareness Debug View</h1>

			<section style={{ marginTop: 24 }}>
				<h2>Local User</h2>
				<div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
					<div
						style={{
							width: 24,
							height: 24,
							borderRadius: '50%',
							background: localUser.color,
						}}
					/>
					<span>
						{localUser.name} ({localUser.id.slice(0, 8)})
					</span>
				</div>
			</section>

			<section style={{ marginTop: 24 }}>
				<h2>Simulate Presence</h2>
				<p style={{ color: '#666', marginTop: 8 }}>
					Set your artifact path to simulate being in an editor. Open multiple tabs to test awareness
					visibility.
				</p>
				<div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
					<input
						type="text"
						value={simulatedPath}
						onChange={(e) => setPresencePath(e.target.value)}
						placeholder="e.g. /artifacts/plan.md"
						style={{ padding: '8px 12px', width: 300, border: '1px solid #ccc', borderRadius: 4 }}
					/>
					<button
						onClick={() => setPresencePath('/artifacts/plan.md')}
						style={{ padding: '8px 16px', borderRadius: 4, border: '1px solid #ccc', cursor: 'pointer' }}
					>
						plan.md
					</button>
					<button
						onClick={() => setPresencePath('/artifacts/research.md')}
						style={{ padding: '8px 16px', borderRadius: 4, border: '1px solid #ccc', cursor: 'pointer' }}
					>
						research.md
					</button>
					<button
						onClick={() => setPresencePath('')}
						style={{ padding: '8px 16px', borderRadius: 4, border: '1px solid #ccc', cursor: 'pointer' }}
					>
						Clear
					</button>
				</div>
			</section>

			<section style={{ marginTop: 24 }}>
				<h2>Local Awareness State</h2>
				<pre
					style={{
						background: '#f5f5f5',
						padding: 16,
						borderRadius: 4,
						overflow: 'auto',
						maxHeight: 200,
					}}
				>
					{rawState}
				</pre>
			</section>

			<section style={{ marginTop: 24 }}>
				<h2>All Clients</h2>
				<AwarenessDebugPanel />
			</section>

			<section style={{ marginTop: 24 }}>
				<h2>Filtered: /artifacts/plan.md</h2>
				<AwarenessDebugPanel filterByArtifact="/artifacts/plan.md" />
			</section>

			<section style={{ marginTop: 24 }}>
				<h2>Filtered: /artifacts/research.md</h2>
				<AwarenessDebugPanel filterByArtifact="/artifacts/research.md" />
			</section>
		</div>
	)
}
