import { createRootRoute, Link, Outlet } from '@tanstack/react-router'
import { ConnectionStatus } from '../components/ConnectionStatus'
import { ArtifactProvider } from '../providers/ArtifactProvider'

export const Route = createRootRoute({
	component: RootLayout,
})

function RootLayout() {
	return (
		<ArtifactProvider>
			<div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
				<ConnectionStatus />
				<nav
					style={{
						display: 'flex',
						gap: 16,
						padding: '8px 16px',
						borderBottom: '1px solid #e0e0e0',
						background: '#fff',
					}}
				>
					<Link to="/" style={{ textDecoration: 'none', color: '#1976d2' }}>
						Home
					</Link>
					<Link
						to="/single"
						search={{ path: '/artifacts/plan.md', mode: 'fragment' }}
						style={{ textDecoration: 'none', color: '#1976d2' }}
					>
						Single Editor
					</Link>
					<Link
						to="/compare"
						search={{ left: '/artifacts/plan.md', right: '/artifacts/research.md' }}
						style={{ textDecoration: 'none', color: '#1976d2' }}
					>
						Compare (Two Paths)
					</Link>
					<Link
						to="/same-doc"
						search={{ path: '/artifacts/plan.md' }}
						style={{ textDecoration: 'none', color: '#1976d2' }}
					>
						Same Doc (Two Editors)
					</Link>
					<Link to="/awareness" style={{ textDecoration: 'none', color: '#1976d2' }}>
						Awareness Debug
					</Link>
				</nav>
				<div style={{ flex: 1, overflow: 'auto' }}>
					<Outlet />
				</div>
			</div>
		</ArtifactProvider>
	)
}
