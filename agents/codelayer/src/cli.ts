#!/usr/bin/env bun
import 'zod/compile'
import { createCodelayerCommand } from './command'

await createCodelayerCommand().parseAsync(process.argv)
