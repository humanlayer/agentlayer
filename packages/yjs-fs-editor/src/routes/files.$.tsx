import { createFileRoute } from '@tanstack/react-router'
import { Layout } from '../components/Layout'

export const Route = createFileRoute('/files/$')({
	component: FilesRoute,
})

function FilesRoute() {
	const { _splat } = Route.useParams()
	const activePath = _splat ? `/${_splat}` : '/'

	return <Layout activePath={activePath} />
}
