export {
	assistantText,
	assistantWithToolCall,
	assistantWithToolCalls,
	getToolResults,
	makeToolContext,
	mockModel,
	outputValue,
	userMessage,
} from '../../agentlayer-core/test/mocks'

import { YjsFilesystem } from '@humanlayer/yjs-fs'
import * as Y from 'yjs'

export function createSyncedYjsFilesystems() {
	const docA = new Y.Doc()
	const docB = new Y.Doc()

	function syncBothWays() {
		Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA))
		Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB))
	}

	return {
		fsA: new YjsFilesystem({ doc: docA }),
		fsB: new YjsFilesystem({ doc: docB }),
		syncBothWays,
	}
}
