import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { ArtifactEditor } from '../components/ArtifactEditor'
import { AwarenessDebugPanel } from '../components/AwarenessDebugPanel'
import { MarkdownExportPanel } from '../components/MarkdownExportPanel'
import { useArtifactSession } from '../providers/ArtifactProvider'

type CompareSearch = {
	left: string
	right: string
}

export const Route = createFileRoute('/compare')({
	component: CompareRoute,
	validateSearch: (search: Record<string, unknown>): CompareSearch => ({
		left: typeof search.left === 'string' ? search.left : '/artifacts/plan.md',
		right: typeof search.right === 'string' ? search.right : '/artifacts/research.md',
	}),
})

function CompareRoute() {
	const { left, right } = Route.useSearch()
	const navigate = useNavigate({ from: '/compare' })
	const { store } = useArtifactSession()

	store.ensureArtifact(left)
	store.ensureArtifact(right)

	return (
		<div style={{ padding: 16, height: '100%', display: 'flex', flexDirection: 'column', gap: 16 }}>
			<h2 style={{ margin: 0 }}>Compare: Two Different Artifacts</h2>
			<p style={{ margin: 0, color: '#666' }}>
				Open this page in two browser tabs. Edit different artifacts and verify cursors do NOT leak between
				them.
			</p>

			<div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
				<label>
					Left:{' '}
					<input
						type="text"
						value={left}
						onChange={(e) => navigate({ to: '/compare', search: { left: e.target.value, right } })}
						style={{ padding: '4px 8px', width: 200 }}
					/>
				</label>
				<label>
					Right:{' '}
					<input
						type="text"
						value={right}
						onChange={(e) => navigate({ to: '/compare', search: { left, right: e.target.value } })}
						style={{ padding: '4px 8px', width: 200 }}
					/>
				</label>
			</div>

			<div style={{ flex: 1, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, minHeight: 0 }}>
				<div style={{ display: 'flex', flexDirection: 'column', gap: 8, overflow: 'auto' }}>
					<h3 style={{ margin: 0 }}>{left}</h3>
					<div style={{ flex: 1, minHeight: 200 }}>
						<ArtifactEditor path={left} />
					</div>
					<MarkdownExportPanel path={left} />
				</div>
				<div style={{ display: 'flex', flexDirection: 'column', gap: 8, overflow: 'auto' }}>
					<h3 style={{ margin: 0 }}>{right}</h3>
					<div style={{ flex: 1, minHeight: 200 }}>
						<ArtifactEditor path={right} />
					</div>
					<MarkdownExportPanel path={right} />
				</div>
			</div>

			<AwarenessDebugPanel />
		</div>
	)
}
