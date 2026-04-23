# Skills

Skills are markdown files that provide specialized instructions or capabilities to agents. The filesystem package provides factories for loading skills from directories.

## Creating Skills

Skills are markdown files with optional frontmatter:

```markdown
---
name: refactor
description: Extract and refactor code into reusable functions
---

# Refactoring Guidelines

When refactoring code:

1. Identify repeated patterns
2. Extract into well-named functions
3. Add appropriate type annotations
4. Update all call sites
5. Run tests to verify behavior

## Example

Before:
\`\`\`ts
const result1 = data.filter(x => x.active).map(x => x.name)
const result2 = items.filter(x => x.active).map(x => x.name)
\`\`\`

After:
\`\`\`ts
const getActiveNames = <T extends { active: boolean; name: string }>(items: T[]) =>
  items.filter(x => x.active).map(x => x.name)

const result1 = getActiveNames(data)
const result2 = getActiveNames(items)
\`\`\`
```

## Loading Skills

### createSkillToolFromRepoDirs()

Load skills from standard repository directories.

```ts
import { createSkillToolFromRepoDirs } from '@humanlayer/agentlayer-filesystem'

const skillTool = await createSkillToolFromRepoDirs({
  cwd: process.cwd(),
  candidates: ['.claude/skills', '.agents/skills'],
  allowMissing: true
})
```

Searches for skill files in the specified directories and creates a tool that can invoke them.

**Options:**

```ts
interface CreateSkillToolFromRepoDirsOptions {
  cwd?: string               // Working directory to search from (defaults to process.cwd())
  candidates?: string[]      // Directories to search
  skills?: Skill[]           // Additional skills to include
  allowMissing?: boolean     // Don't error if directories don't exist
}
```

### createSkillToolFromDirs()

Load skills from explicit directories with optional namespacing.

```ts
import { createSkillToolFromDirs } from '@humanlayer/agentlayer-filesystem'

const skillTool = await createSkillToolFromDirs({
  dirs: [
    { path: '.claude/skills' },
    { path: 'shared/skills', namespace: 'shared' }
  ]
})
```

With namespacing, skills are invoked as `shared:skill-name`.

**Options:**

The function accepts inline options (no named interface exported):

```ts
interface SkillDirEntry {
  path: string
  namespace?: string
}

// Function signature:
createSkillToolFromDirs(opts: {
  dirs: string | string[] | SkillDirEntry[]  // Directory paths or entries
  skills?: Skill[]                            // Additional skills to include
})
```

## Skill Type

```ts
interface Skill {
  name: string
  description: string
  content: string
  baseDir?: string    // Populated when skills are loaded from directories
}
```

## Using Skills in Agents

Skills are typically included via toolset factories:

```ts
import { createClaudeCodingAgentToolset } from '@humanlayer/agentlayer-filesystem'

const tools = await createClaudeCodingAgentToolset({
  cwd: process.cwd(),
  skillDirs: ['.claude/skills', '.agents/skills']
})
```

Or add a standalone skill tool:

```ts
import { Agent } from '@humanlayer/agentlayer-core'
import { createSkillToolFromRepoDirs } from '@humanlayer/agentlayer-filesystem'

const skillTool = await createSkillToolFromRepoDirs({
  cwd: process.cwd()
})

const agent = new Agent({
  model: 'claude-sonnet-4-20250514',
  tools: [skillTool, ...otherTools],
  system: '...'
})
```

## Providing Skills Directly

Instead of loading from files, provide skills directly:

```ts
import { createSkillToolFromDirs } from '@humanlayer/agentlayer-filesystem'

const skillTool = await createSkillToolFromDirs({
  dirs: [],
  skills: [
    {
      name: 'debug',
      description: 'Debug a failing test',
      content: '# Debugging Steps\n\n1. Read the test file...'
    }
  ]
})
```

## Skill Discovery

The skill tool automatically discovers skills from:

1. Files in specified directories (`.md` files)
2. Skills provided directly via the `skills` option
3. Namespaced directories for organization

Agents can then invoke skills by name:

```
User: Use the refactor skill to clean up src/utils.ts
Agent: [calls skill tool with { skill: 'refactor', args: 'src/utils.ts' }]
```
