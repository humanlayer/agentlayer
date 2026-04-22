#!/usr/bin/env bun
import { createCodelayerCommand } from './command'

await createCodelayerCommand().parseAsync(process.argv)
