import { createRootRoute, Outlet } from '@tanstack/react-router'
import { FilesystemProvider } from '../providers/FilesystemProvider'
export const Route = createRootRoute({
	component: RootLayout,
	beforeLoad: () => {},
})

function RootLayout() {
	return (
		<FilesystemProvider>
			<Outlet />
		</FilesystemProvider>
	)
}
