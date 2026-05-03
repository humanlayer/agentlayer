import type { YjsFilesystem } from '@humanlayer/yjs-fs'
import {
	allowAllFs,
	allowAllNetwork,
	createDefaultNetworkAdapter,
	createNodeDriver,
	createNodeRuntimeDriverFactory,
	NodeRuntime,
} from 'secure-exec'
import { YjsFsSecureExecAdapter } from './adapter'

type NodeDriverOptions = NonNullable<Parameters<typeof createNodeDriver>[0]>

export interface CreateYjsFsRuntimeOptions {
	permissions?: NodeDriverOptions['permissions']
	/** Enable secure-exec's default network adapter and allow network access. */
	enableNetwork?: boolean
	/** Loopback ports exempt from secure-exec's default private-IP/SSRF protection. */
	loopbackExemptPorts?: number[]
	/** Host project directory whose node_modules are exposed read-only to sandbox module resolution. */
	moduleAccessCwd?: string
}

export function createYjsFsRuntime(fs: YjsFilesystem, opts: CreateYjsFsRuntimeOptions = {}) {
	const adapter = new YjsFsSecureExecAdapter(fs)
	const permissions = {
		...allowAllFs,
		...(opts.enableNetwork ? allowAllNetwork : {}),
		...(opts.permissions ?? {}),
	}
	const runtime = new NodeRuntime({
		systemDriver: createNodeDriver({
			filesystem: adapter,
			...(opts.enableNetwork
				? { networkAdapter: createDefaultNetworkAdapter({ initialExemptPorts: opts.loopbackExemptPorts }) }
				: {}),
			...(opts.moduleAccessCwd ? { moduleAccess: { cwd: opts.moduleAccessCwd } } : {}),
			permissions,
		}),
		runtimeDriverFactory: createNodeRuntimeDriverFactory(),
	})
	return { runtime, adapter } as const
}
