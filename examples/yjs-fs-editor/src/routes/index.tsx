import { Navigate, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
	component: IndexRoute,
})

function IndexRoute() {
	return <Navigate to="/files/$" params={{ _splat: '' }} search={(prev) => prev} />
}
