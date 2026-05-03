import { createSecureApplyTool, type SecureApplyExecutor } from './secure-apply-tool'

export function createYjsMarkdownApplyTools(executor: SecureApplyExecutor) {
	return {
		secure_apply_yjs_update: createSecureApplyTool(executor),
	}
}
