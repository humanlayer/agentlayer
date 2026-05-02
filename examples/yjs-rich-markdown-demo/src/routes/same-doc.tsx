import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { ArtifactEditor } from '../components/ArtifactEditor'
import { AwarenessDebugPanel } from '../components/AwarenessDebugPanel'
import { MarkdownExportPanel } from '../components/MarkdownExportPanel'
import { useArtifactSession } from '../providers/ArtifactProvider'

type SameDocSearch = {
	path: string
}

export const Route = createFileRoute('/same-doc')({
	component: SameDocRoute,
	validateSearch: (search: Record<string, unknown>): SameDocSearch => ({
		path: typeof search.path === 'string' ? search.path : '/artifacts/plan.md',
	}),
})

function SameDocRoute() {
	const { path } = Route.useSearch()
	const navigate = useNavigate({ from: '/same-doc' })
	const { store } = useArtifactSession()

	store.ensureArtifact(path)

	return (
		<div style={{ padding: 16, height: '100%', display: 'flex', flexDirection: 'column', gap: 16 }}>
			<h2 style={{ margin: 0 }}>Same Doc: Two Editors, One Artifact</h2>
			<p style={{ margin: 0, color: '#666' }}>
				Both editors show the same artifact. Open in two browser tabs to verify cursors are visible across
				clients.
			</p>

			<div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
				<label>
					Path:{' '}
					<input
						type="text"
						value={path}
						onChange={(e) => navigate({ to: '/same-doc', search: { path: e.target.value } })}
						style={{ padding: '4px 8px', width: 300 }}
					/>
				</label>
			</div>

			<div style={{ flex: 1, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, minHeight: 0 }}>
				<div style={{ display: 'flex', flexDirection: 'column', gap: 8, overflow: 'auto' }}>
					<h3 style={{ margin: 0 }}>Editor A: {path}</h3>
					<div style={{ flex: 1, minHeight: 200 }}>
						<ArtifactEditor path={path} />
					</div>
				</div>
				<div style={{ display: 'flex', flexDirection: 'column', gap: 8, overflow: 'auto' }}>
					<h3 style={{ margin: 0 }}>Editor B: {path}</h3>
					<div style={{ flex: 1, minHeight: 200 }}>
						<ArtifactEditor path={path} />
					</div>
				</div>
			</div>

			<div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
				<AwarenessDebugPanel filterByArtifact={path} />
				<MarkdownExportPanel path={path} />
			</div>
		</div>
	)
}
