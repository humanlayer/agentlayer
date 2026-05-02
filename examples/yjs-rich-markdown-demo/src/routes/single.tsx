import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { ArtifactEditor } from '../components/ArtifactEditor'
import { AwarenessDebugPanel } from '../components/AwarenessDebugPanel'
import { MarkdownExportPanel } from '../components/MarkdownExportPanel'
import { useArtifactSession } from '../providers/ArtifactProvider'

type SingleSearch = {
	path: string
	mode: 'fragment' | 'field'
}

export const Route = createFileRoute('/single')({
	component: SingleRoute,
	validateSearch: (search: Record<string, unknown>): SingleSearch => ({
		path: typeof search.path === 'string' ? search.path : '/artifacts/plan.md',
		mode: search.mode === 'field' ? 'field' : 'fragment',
	}),
})

function SingleRoute() {
	const { path, mode } = Route.useSearch()
	const navigate = useNavigate({ from: '/single' })
	const { store } = useArtifactSession()

	store.ensureArtifact(path)

	return (
		<div style={{ padding: 16, height: '100%', display: 'flex', flexDirection: 'column', gap: 16 }}>
			<div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
				<label>
					Path:{' '}
					<input
						type="text"
						value={path}
						onChange={(e) => navigate({ to: '/single', search: { path: e.target.value, mode } })}
						style={{ padding: '4px 8px', width: 250 }}
					/>
				</label>
				<label>
					Mode:{' '}
					<select
						value={mode}
						onChange={(e) =>
							navigate({ to: '/single', search: { path, mode: e.target.value as 'fragment' | 'field' } })
						}
						style={{ padding: '4px 8px' }}
					>
						<option value="fragment">fragment</option>
						<option value="field">field</option>
					</select>
				</label>
			</div>

			<div style={{ flex: 1, display: 'grid', gridTemplateColumns: '1fr 300px', gap: 16, minHeight: 0 }}>
				<div style={{ overflow: 'auto' }}>
					<h3 style={{ margin: '0 0 8px' }}>Editor: {path}</h3>
					<ArtifactEditor path={path} mode={mode} />
				</div>
				<div style={{ display: 'flex', flexDirection: 'column', gap: 16, overflow: 'auto' }}>
					<AwarenessDebugPanel filterByArtifact={path} />
					<MarkdownExportPanel path={path} />
				</div>
			</div>
		</div>
	)
}
