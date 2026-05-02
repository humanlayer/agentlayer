import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { ArtifactList } from '../components/ArtifactList'
import { useArtifactSession } from '../providers/ArtifactProvider'

export const Route = createFileRoute('/')({
	component: IndexRoute,
})

function IndexRoute() {
	const { store, connectionStatus, isSynced } = useArtifactSession()
	const [newPath, setNewPath] = useState('/artifacts/new.md')

	const createArtifact = () => {
		try {
			store.ensureArtifact(newPath)
		} catch (err) {
			alert(String(err))
		}
	}

	return (
		<div style={{ padding: 24, maxWidth: 800 }}>
			<h1>Rich Markdown Learning Demo</h1>

			<section style={{ marginTop: 24 }}>
				<h2>Connection Status</h2>
				<ul>
					<li>Status: {connectionStatus}</li>
					<li>Synced: {isSynced ? 'Yes' : 'No'}</li>
				</ul>
			</section>

			<section style={{ marginTop: 24 }}>
				<h2>Create Artifact</h2>
				<div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
					<input
						type="text"
						value={newPath}
						onChange={(e) => setNewPath(e.target.value)}
						style={{ padding: '8px 12px', border: '1px solid #ccc', borderRadius: 4, width: 300 }}
					/>
					<button
						onClick={createArtifact}
						style={{
							padding: '8px 16px',
							background: '#1976d2',
							color: '#fff',
							border: 'none',
							borderRadius: 4,
							cursor: 'pointer',
						}}
					>
						Create
					</button>
				</div>
			</section>

			<section style={{ marginTop: 24 }}>
				<h2>Existing Artifacts</h2>
				<ArtifactList />
			</section>

			<section style={{ marginTop: 24 }}>
				<h2>Learning Scenarios</h2>
				<ul style={{ lineHeight: 2 }}>
					<li>
						<Link to="/single" search={{ path: '/artifacts/plan.md', mode: 'fragment' }}>
							Single Editor
						</Link>{' '}
						- Edit one artifact
					</li>
					<li>
						<Link to="/compare" search={{ left: '/artifacts/plan.md', right: '/artifacts/research.md' }}>
							Compare
						</Link>{' '}
						- Two editors, two different artifact paths
					</li>
					<li>
						<Link to="/same-doc" search={{ path: '/artifacts/plan.md' }}>
							Same Doc
						</Link>{' '}
						- Two editors, same artifact path
					</li>
					<li>
						<Link to="/awareness">Awareness Debug</Link> - Raw awareness state inspection
					</li>
				</ul>
			</section>

			<section style={{ marginTop: 24 }}>
				<h2>Learning Goals</h2>
				<ol style={{ lineHeight: 1.8 }}>
					<li>Multiple TipTap fragments in one Y.Doc keep content isolated</li>
					<li>Durable Streams syncs all fragments in one document</li>
					<li>Users editing the same artifact see each other's cursors</li>
					<li>Users editing different artifacts do NOT see each other's cursors</li>
					<li>Markdown export works per artifact</li>
				</ol>
			</section>
		</div>
	)
}
