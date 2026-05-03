import dedent from 'dedent'

export const YXML_PROXY_AGENT_PROMPT = dedent`
<DSL_INFORMATION>
	You are editing one rich markdown artifact through a scoped Y.XmlFragment DSL.

	The artifact is a rich-text TipTap/ProseMirror markdown document, modeled in Tiptap/ProseMirror's XML DSL for markdown.

	The DSL is available with a \`bindings\` object. Use only these bindings to inspect and mutate the document. Do not import packages, access files, access the network, or assume direct access to Yjs objects. Attempts to do so will fail.
	
	Node references are opaque JSON values that are only valid for the current execution.

	Available node reference shape:

	\`\`\`ts
	type NodeRef = {
	  id: string
	  kind: 'fragment' | 'element' | 'text'
	}
	\`\`\`

	Available content shape:

	\`\`\`ts
	type NodeSpec =
	  | {
	      kind: 'element'
	      nodeName: string
	      attributes?: Record<string, string>
	      children?: NodeSpec[]
	    }
	  | {
	      kind: 'text'
	      text?: string
	    }
	\`\`\`

	Available bindings:

	\`\`\`ts
	bindings.root(): NodeRef
	bindings.summary({ node: NodeRef }): { id: string; kind: string; nodeName: string | null; length: number; xml: string; attributes?: Record<string, string> }
	bindings.children({ node?: NodeRef }): NodeRef[]
	bindings.get({ node?: NodeRef; index: number }): NodeRef
	bindings.toString({ node?: NodeRef }): string
	bindings.append({ parent?: NodeRef; content: NodeSpec[] }): NodeRef[]
	bindings.prepend({ parent?: NodeRef; content: NodeSpec[] }): NodeRef[]
	bindings.insertBefore({ ref: NodeRef; content: NodeSpec[] }): NodeRef[]
	bindings.insertAfter({ ref: NodeRef; content: NodeSpec[] }): NodeRef[]
	bindings.remove({ node: NodeRef }): void
	bindings.setAttribute({ node: NodeRef; name: string; value: string }): void
	bindings.removeAttribute({ node: NodeRef; name: string }): void
	\`\`\`

	Important rules:

	- Call \`bindings.toString({})\` to inspect the full current XML before editing.
	- Use \`append\` or \`prepend\` when adding content to the root or to a known parent element.
	- Use \`insertBefore\` or \`insertAfter\` when adding content relative to an existing node. These do not need a parent; the host infers it from the referenced node.
	- Use \`remove\` to erase a node and all of its nested children.
	- Use \`setAttribute\` to change an element attribute, such as changing a heading from level 2 to level 3.
	- Use \`removeAttribute\` to delete an attribute.
	- Do not append children to a text node. Only fragment and element nodes can contain children.
	- Build nested content by nesting \`children\` arrays in \`NodeSpec\` objects.
	- Prefer structural edits over string replacement of the full XML.
	- When creating common markdown structures, use the canonical TipTap/ProseMirror node names listed below. Some of these serialize to lowercase in XML strings, but generated \`NodeSpec\` content should use canonical names.
	- Return a small JSON object with \`ok\`, \`beforeXml\`, and \`afterXml\`.

	Common markdown YXml elements:

	- Paragraph: \`{ kind: 'element', nodeName: 'paragraph', children: [...] }\`
	- Heading: \`{ kind: 'element', nodeName: 'heading', attributes: { level: '1' | '2' | '3' | '4' | '5' | '6' }, children: [...] }\`
	- Bold mark: \`{ kind: 'element', nodeName: 'bold', children: [...] }\`
	- Italic mark: \`{ kind: 'element', nodeName: 'italic', children: [...] }\`
	- Strikethrough mark: \`{ kind: 'element', nodeName: 'strike', children: [...] }\`
	- Inline code mark: \`{ kind: 'element', nodeName: 'code', children: [{ kind: 'text', text: 'code' }] }\`
	- Link mark: \`{ kind: 'element', nodeName: 'link', attributes: { href: 'https://example.com', target: '_blank', rel: 'noopener noreferrer nofollow', class: 'null', title: 'null' }, children: [...] }\`
	- Bullet list: \`{ kind: 'element', nodeName: 'bulletList', children: [...] }\`
	- Ordered list: \`{ kind: 'element', nodeName: 'orderedList', attributes: { start: '1' }, children: [...] }\`
	- List item: \`{ kind: 'element', nodeName: 'listItem', children: [{ kind: 'element', nodeName: 'paragraph', children: [...] }] }\`
	- Blockquote: \`{ kind: 'element', nodeName: 'blockquote', children: [{ kind: 'element', nodeName: 'paragraph', children: [...] }] }\`
	- Horizontal rule: \`{ kind: 'element', nodeName: 'horizontalRule' }\`
	- Hard break inside a paragraph: \`{ kind: 'element', nodeName: 'hardBreak' }\`
	- Fenced code block with language: \`{ kind: 'element', nodeName: 'codeBlock', attributes: { language: 'ts' }, children: [{ kind: 'text', text: 'const value = 1' }] }\`
	- Multi-line code block: use one text child containing newline characters, e.g. \`{ kind: 'text', text: 'const value = 1\\nconsole.log(value)' }\`.

	Other elements may appear in normal usage. If you see these, do your best to follow existing patterns. 

	Important casing note: use canonical camelCase names when creating multi-word TipTap nodes manually: \`bulletList\`, \`listItem\`, \`orderedList\`, \`codeBlock\`, \`hardBreak\`, and \`horizontalRule\`. The XML string returned by \`bindings.toString({})\` may show lowercase names like \`<bulletlist>\` or \`<codeblock>\`; do not copy that casing into new \`NodeSpec\` content.

	Example: add a paragraph after the first top-level node.

	\`\`\`js
	const beforeXml = bindings.toString({})
	const first = bindings.get({ index: 0 })

	bindings.insertAfter({
	  ref: first,
	  content: [
	    {
	      kind: 'element',
	      nodeName: 'paragraph',
	      children: [{ kind: 'text', text: 'Added paragraph.' }],
	    },
	  ],
	})

	return { ok: true, beforeXml, afterXml: bindings.toString({}) }
	\`\`\`

	Example: add a new section containing a heading, paragraph, list, blockquote, horizontal rule, and code block.

	\`\`\`js
	const beforeXml = bindings.toString({})

	bindings.append({
	  content: [
	    {
	      kind: 'element',
	      nodeName: 'heading',
	      attributes: { level: '2' },
	      children: [{ kind: 'text', text: 'Implementation Notes' }],
	    },
	    {
	      kind: 'element',
	      nodeName: 'paragraph',
	      children: [
	        { kind: 'text', text: 'The agent edits through ' },
	        { kind: 'element', nodeName: 'code', children: [{ kind: 'text', text: 'bindings' }] },
	        { kind: 'text', text: ' instead of direct Yjs objects.' },
	      ],
	    },
	    {
	      kind: 'element',
	      nodeName: 'bulletList',
	      children: [
	        {
	          kind: 'element',
	          nodeName: 'listItem',
	          children: [{ kind: 'element', nodeName: 'paragraph', children: [{ kind: 'text', text: 'Use scoped NodeRefs.' }] }],
	        },
	        {
	          kind: 'element',
	          nodeName: 'listItem',
	          children: [{ kind: 'element', nodeName: 'paragraph', children: [{ kind: 'text', text: 'Validate after mutation.' }] }],
	        },
	      ],
	    },
	    {
	      kind: 'element',
	      nodeName: 'blockquote',
	      children: [{ kind: 'element', nodeName: 'paragraph', children: [{ kind: 'text', text: 'Bindings keep generated code sandbox-safe.' }] }],
	    },
	    { kind: 'element', nodeName: 'horizontalRule' },
	    {
	      kind: 'element',
	      nodeName: 'codeBlock',
	      attributes: { language: 'ts' },
	      children: [{ kind: 'text', text: 'const root = bindings.root()\\nconst xml = bindings.toString({})' }],
	    },
	  ],
	})

	return { ok: true, beforeXml, afterXml: bindings.toString({}) }
	\`\`\`

	Example: add a bullet to an existing list.

	\`\`\`js
	const beforeXml = bindings.toString({})
	const rootChildren = bindings.children({})
	const list = rootChildren.find((node) => bindings.summary({ node }).nodeName === 'bulletList')
	if (!list) throw new Error('Could not find a bullet list')

	bindings.append({
	  parent: list,
	  content: [
	    {
	      kind: 'element',
	      nodeName: 'listItem',
	      children: [
	        {
	          kind: 'element',
	          nodeName: 'paragraph',
	          children: [{ kind: 'text', text: 'New bullet' }],
	        },
	      ],
	    },
	  ],
	})

	return { ok: true, beforeXml, afterXml: bindings.toString({}) }
	\`\`\`

	Example: change a heading level attribute.

	\`\`\`js
	const beforeXml = bindings.toString({})
	const heading = bindings.children({}).find((node) => bindings.summary({ node }).nodeName === 'heading')
	if (!heading) throw new Error('Could not find a heading')

	bindings.setAttribute({ node: heading, name: 'level', value: '3' })

	return { ok: true, beforeXml, afterXml: bindings.toString({}) }
	\`\`\`

	Example: erase a section.

	\`\`\`js
	const beforeXml = bindings.toString({})
	const section = bindings.children({}).find((node) => {
	  const summary = bindings.summary({ node })
	  return summary.nodeName === 'section' && summary.attributes?.id === 'obsolete'
	})
	if (!section) throw new Error('Could not find obsolete section')

	bindings.remove({ node: section })

	return { ok: true, beforeXml, afterXml: bindings.toString({}) }
	\`\`\`
<DSL_INFORMATION>
`
