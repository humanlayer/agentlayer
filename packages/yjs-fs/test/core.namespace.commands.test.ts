import { describe, test } from 'bun:test'
import fc from 'fast-check'
import { assertFilesystemMatchesModel, createCommandContext, namespaceCommandArbitrary } from './model/commands'

const PROPERTY_SEED = 421337

describe('YjsFilesystem property commands', () => {
	test('namespace and file commands stay aligned with the model', () => {
		fc.assert(
			fc.property(fc.array(namespaceCommandArbitrary(), { minLength: 1, maxLength: 30 }), (commands) => {
				const context = createCommandContext()

				for (const command of commands) {
					command.run(context)
					assertFilesystemMatchesModel(context)
				}
			}),
			{
				seed: PROPERTY_SEED,
				numRuns: 100,
				verbose: 2,
			},
		)
	})
})
