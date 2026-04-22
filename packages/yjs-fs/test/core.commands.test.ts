import { describe, test } from 'bun:test'
import fc from 'fast-check'
import { assertFilesystemMatchesModel, createCommandContext, namespaceCommandArbitrary } from './model/commands'

const PROPERTY_SEED = 421337

describe('YjsFilesystem property commands', () => {
	test('namespace and file commands stay aligned with the model', () => {
		const executedCommands: string[] = []

		try {
			fc.assert(
				fc.property(fc.array(namespaceCommandArbitrary(), { minLength: 1, maxLength: 30 }), (commands) => {
					executedCommands.length = 0
					const context = createCommandContext()

					for (const command of commands) {
						executedCommands.push(command.label)
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
		} catch (error) {
			const details = error instanceof Error ? String(error.cause ?? error.message) : String(error)
			throw new Error(
				`Seed ${PROPERTY_SEED} failed after commands: ${formatCommands(executedCommands)}\n${details}`,
				{
					cause: error,
				},
			)
		}
	})
})

function formatCommands(commands: string[]): string {
	return commands.length === 0 ? '(none)' : commands.join(', ')
}
