export { createPresenceHooks } from '../tools/y-stream-fs/presence-hooks'
export {
	type DeduplicateReadsOptions,
	deduplicateReads,
	type StripThinkingOptions,
	stripThinkingTokens,
	type TruncateOldBashResultsOptions,
	truncateOldBashResults,
} from './context-transforms'
export {
	bashOutputTruncationHook,
	createBashOutputTruncationHook,
	createGlobOutputTruncationHook,
	createGrepOutputTruncationHook,
	createListOutputTruncationHook,
	createReadTruncationHook,
	globOutputTruncationHook,
	grepOutputTruncationHook,
	listOutputTruncationHook,
	type OutputTruncationOptions,
	type ReadTruncationOptions,
	readTruncationHook,
	saneDefaultOutputTruncationHooks,
	saveFullOutput,
	type TruncationOptions,
	type TruncationResult,
	truncateWithOptions,
} from './output-truncation'
