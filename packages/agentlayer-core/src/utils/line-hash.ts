/**
 * Lightweight line-hash utilities extracted from hashline.ts to avoid
 * circular dependencies (prompt-templates → hashline → tools → edit).
 */

/**
 * 647 single-token BPE bigrams for hashline anchors. Every entry tokenizes as
 * exactly one token in modern BPE vocabularies (cl100k / o200k / Claude family),
 * so a hashline anchor built from one bigram is exactly 1 token.
 *
 * This is the complete set of 2-letter lowercase combinations that are single
 * tokens — the 29 missing combinations are rare-letter pairs (q/x/z heavy)
 * that no major BPE vocabulary merges into a single token.
 *
 * Order is stable forever — changing it would invalidate every saved
 * `LINE+ID` reference in transcripts and prompts.
 */
export const HASHLINE_BIGRAMS = [
	'aa',
	'ab',
	'ac',
	'ad',
	'ae',
	'af',
	'ag',
	'ah',
	'ai',
	'aj',
	'ak',
	'al',
	'am',
	'an',
	'ao',
	'ap',
	'aq',
	'ar',
	'as',
	'at',
	'au',
	'av',
	'aw',
	'ax',
	'ay',
	'az',
	'ba',
	'bb',
	'bc',
	'bd',
	'be',
	'bf',
	'bg',
	'bh',
	'bi',
	'bj',
	'bk',
	'bl',
	'bm',
	'bn',
	'bo',
	'bp',
	'br',
	'bs',
	'bt',
	'bu',
	'bv',
	'bw',
	'bx',
	'by',
	'bz',
	'ca',
	'cb',
	'cc',
	'cd',
	'ce',
	'cf',
	'cg',
	'ch',
	'ci',
	'cj',
	'ck',
	'cl',
	'cm',
	'cn',
	'co',
	'cp',
	'cq',
	'cr',
	'cs',
	'ct',
	'cu',
	'cv',
	'cw',
	'cx',
	'cy',
	'cz',
	'da',
	'db',
	'dc',
	'dd',
	'de',
	'df',
	'dg',
	'dh',
	'di',
	'dj',
	'dk',
	'dl',
	'dm',
	'dn',
	'do',
	'dp',
	'dq',
	'dr',
	'ds',
	'dt',
	'du',
	'dv',
	'dw',
	'dx',
	'dy',
	'dz',
	'ea',
	'eb',
	'ec',
	'ed',
	'ee',
	'ef',
	'eg',
	'eh',
	'ei',
	'ej',
	'ek',
	'el',
	'em',
	'en',
	'eo',
	'ep',
	'eq',
	'er',
	'es',
	'et',
	'eu',
	'ev',
	'ew',
	'ex',
	'ey',
	'ez',
	'fa',
	'fb',
	'fc',
	'fd',
	'fe',
	'ff',
	'fg',
	'fh',
	'fi',
	'fj',
	'fk',
	'fl',
	'fm',
	'fn',
	'fo',
	'fp',
	'fq',
	'fr',
	'fs',
	'ft',
	'fu',
	'fv',
	'fw',
	'fx',
	'fy',
	'fz',
	'ga',
	'gb',
	'gc',
	'gd',
	'ge',
	'gf',
	'gg',
	'gh',
	'gi',
	'gj',
	'gl',
	'gm',
	'gn',
	'go',
	'gp',
	'gr',
	'gs',
	'gt',
	'gu',
	'gv',
	'gw',
	'gx',
	'gy',
	'gz',
	'ha',
	'hb',
	'hc',
	'hd',
	'he',
	'hf',
	'hg',
	'hh',
	'hi',
	'hj',
	'hk',
	'hl',
	'hm',
	'hn',
	'ho',
	'hp',
	'hq',
	'hr',
	'hs',
	'ht',
	'hu',
	'hv',
	'hw',
	'hx',
	'hy',
	'hz',
	'ia',
	'ib',
	'ic',
	'id',
	'ie',
	'if',
	'ig',
	'ih',
	'ii',
	'ij',
	'ik',
	'il',
	'im',
	'in',
	'io',
	'ip',
	'iq',
	'ir',
	'is',
	'it',
	'iu',
	'iv',
	'iw',
	'ix',
	'iy',
	'iz',
	'ja',
	'jb',
	'jc',
	'jd',
	'je',
	'jf',
	'jg',
	'jh',
	'ji',
	'jj',
	'jk',
	'jl',
	'jm',
	'jn',
	'jo',
	'jp',
	'jq',
	'jr',
	'js',
	'jt',
	'ju',
	'jw',
	'jx',
	'jy',
	'ka',
	'kb',
	'kc',
	'kd',
	'ke',
	'kf',
	'kg',
	'kh',
	'ki',
	'kj',
	'kk',
	'kl',
	'km',
	'kn',
	'ko',
	'kp',
	'kr',
	'ks',
	'kt',
	'ku',
	'kv',
	'kw',
	'kx',
	'ky',
	'la',
	'lb',
	'lc',
	'ld',
	'le',
	'lf',
	'lg',
	'lh',
	'li',
	'lj',
	'lk',
	'll',
	'lm',
	'ln',
	'lo',
	'lp',
	'lr',
	'ls',
	'lt',
	'lu',
	'lv',
	'lw',
	'lx',
	'ly',
	'lz',
	'ma',
	'mb',
	'mc',
	'md',
	'me',
	'mf',
	'mg',
	'mh',
	'mi',
	'mj',
	'mk',
	'ml',
	'mm',
	'mn',
	'mo',
	'mp',
	'mq',
	'mr',
	'ms',
	'mt',
	'mu',
	'mv',
	'mw',
	'mx',
	'my',
	'mz',
	'na',
	'nb',
	'nc',
	'nd',
	'ne',
	'nf',
	'ng',
	'nh',
	'ni',
	'nj',
	'nk',
	'nl',
	'nm',
	'nn',
	'no',
	'np',
	'nr',
	'ns',
	'nt',
	'nu',
	'nv',
	'nw',
	'nx',
	'ny',
	'nz',
	'oa',
	'ob',
	'oc',
	'od',
	'oe',
	'of',
	'og',
	'oh',
	'oi',
	'oj',
	'ok',
	'ol',
	'om',
	'on',
	'oo',
	'op',
	'oq',
	'or',
	'os',
	'ot',
	'ou',
	'ov',
	'ow',
	'ox',
	'oy',
	'oz',
	'pa',
	'pb',
	'pc',
	'pd',
	'pe',
	'pf',
	'pg',
	'ph',
	'pi',
	'pj',
	'pk',
	'pl',
	'pm',
	'pn',
	'po',
	'pp',
	'pq',
	'pr',
	'ps',
	'pt',
	'pu',
	'pv',
	'pw',
	'px',
	'py',
	'pz',
	'qa',
	'qb',
	'qc',
	'qd',
	'qe',
	'qh',
	'qi',
	'ql',
	'qm',
	'qn',
	'qo',
	'qp',
	'qq',
	'qr',
	'qs',
	'qt',
	'qu',
	'qw',
	'qx',
	'qy',
	'ra',
	'rb',
	'rc',
	'rd',
	're',
	'rf',
	'rg',
	'rh',
	'ri',
	'rk',
	'rl',
	'rm',
	'rn',
	'ro',
	'rp',
	'rq',
	'rr',
	'rs',
	'rt',
	'ru',
	'rv',
	'rw',
	'rx',
	'ry',
	'rz',
	'sa',
	'sb',
	'sc',
	'sd',
	'se',
	'sf',
	'sg',
	'sh',
	'si',
	'sj',
	'sk',
	'sl',
	'sm',
	'sn',
	'so',
	'sp',
	'sq',
	'sr',
	'ss',
	'st',
	'su',
	'sv',
	'sw',
	'sx',
	'sy',
	'sz',
	'ta',
	'tb',
	'tc',
	'td',
	'te',
	'tf',
	'tg',
	'th',
	'ti',
	'tj',
	'tk',
	'tl',
	'tm',
	'tn',
	'to',
	'tp',
	'tr',
	'ts',
	'tt',
	'tu',
	'tv',
	'tw',
	'tx',
	'ty',
	'tz',
	'ua',
	'ub',
	'uc',
	'ud',
	'ue',
	'uf',
	'ug',
	'uh',
	'ui',
	'uj',
	'uk',
	'ul',
	'um',
	'un',
	'uo',
	'up',
	'uq',
	'ur',
	'us',
	'ut',
	'uu',
	'uv',
	'uw',
	'ux',
	'uy',
	'uz',
	'va',
	'vb',
	'vc',
	'vd',
	've',
	'vf',
	'vg',
	'vh',
	'vi',
	'vj',
	'vk',
	'vl',
	'vm',
	'vn',
	'vo',
	'vp',
	'vq',
	'vr',
	'vs',
	'vt',
	'vu',
	'vv',
	'vw',
	'vx',
	'vy',
	'vz',
	'wa',
	'wb',
	'wc',
	'wd',
	'we',
	'wf',
	'wg',
	'wh',
	'wi',
	'wj',
	'wk',
	'wl',
	'wm',
	'wn',
	'wo',
	'wp',
	'wr',
	'ws',
	'wt',
	'wu',
	'wv',
	'ww',
	'wx',
	'wy',
	'xa',
	'xb',
	'xc',
	'xd',
	'xe',
	'xf',
	'xh',
	'xi',
	'xl',
	'xm',
	'xn',
	'xo',
	'xp',
	'xr',
	'xs',
	'xt',
	'xu',
	'xx',
	'xy',
	'xz',
	'ya',
	'yb',
	'yc',
	'yd',
	'ye',
	'yf',
	'yg',
	'yh',
	'yi',
	'yj',
	'yk',
	'yl',
	'ym',
	'yn',
	'yo',
	'yp',
	'yr',
	'ys',
	'yt',
	'yu',
	'yv',
	'yw',
	'yx',
	'yy',
	'yz',
	'za',
	'zb',
	'zc',
	'zd',
	'ze',
	'zf',
	'zg',
	'zh',
	'zi',
	'zk',
	'zl',
	'zm',
	'zn',
	'zo',
	'zp',
	'zr',
	'zs',
	'zt',
	'zu',
	'zw',
	'zx',
	'zy',
	'zz',
] as const

export const HASHLINE_BIGRAMS_COUNT = HASHLINE_BIGRAMS.length

/**
 * Regex source matching exactly one bigram from {@link HASHLINE_BIGRAMS}.
 * Used by hashline parsers — keep in sync with the alphabet array above.
 */
export const HASHLINE_BIGRAM_RE_SRC = `(?:${HASHLINE_BIGRAMS.join('|')})`

export const HASHLINE_CONTENT_SEPARATOR = '|'

const RE_SIGNIFICANT = /[\p{L}\p{N}]/u
const RE_STRUCTURAL_STRIP = /[\s{}]/g

function rotl32(value: number, shift: number): number {
	return ((value << shift) | (value >>> (32 - shift))) >>> 0
}

function round32(accumulator: number, lane: number): number {
	const PRIME32_2 = 2246822519
	const PRIME32_1 = 2654435761
	accumulator = (accumulator + Math.imul(lane, PRIME32_2)) >>> 0
	accumulator = rotl32(accumulator, 13)
	return Math.imul(accumulator, PRIME32_1) >>> 0
}

function mergeRound32(accumulator: number, value: number): number {
	const PRIME32_1 = 2654435761
	const PRIME32_4 = 668265263
	accumulator ^= round32(0, value)
	return (Math.imul(accumulator, PRIME32_1) + PRIME32_4) >>> 0
}

function avalanche32(hash: number): number {
	const PRIME32_2 = 2246822519
	const PRIME32_3 = 3266489917
	hash ^= hash >>> 15
	hash = Math.imul(hash, PRIME32_2) >>> 0
	hash ^= hash >>> 13
	hash = Math.imul(hash, PRIME32_3) >>> 0
	hash ^= hash >>> 16
	return hash >>> 0
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
	return (
		((bytes[offset] ?? 0) |
			((bytes[offset + 1] ?? 0) << 8) |
			((bytes[offset + 2] ?? 0) << 16) |
			((bytes[offset + 3] ?? 0) << 24)) >>>
		0
	)
}

export function xxHash32(input: string, seed = 0): number {
	const PRIME32_1 = 2654435761
	const PRIME32_2 = 2246822519
	const PRIME32_3 = 3266489917
	const PRIME32_4 = 668265263
	const PRIME32_5 = 374761393
	const bytes = new TextEncoder().encode(input)
	let offset = 0
	let hash: number

	if (bytes.length >= 16) {
		let v1 = (seed + PRIME32_1 + PRIME32_2) >>> 0
		let v2 = (seed + PRIME32_2) >>> 0
		let v3 = seed >>> 0
		let v4 = (seed - PRIME32_1) >>> 0
		const limit = bytes.length - 16

		while (offset <= limit) {
			v1 = round32(v1, readUint32LE(bytes, offset))
			offset += 4
			v2 = round32(v2, readUint32LE(bytes, offset))
			offset += 4
			v3 = round32(v3, readUint32LE(bytes, offset))
			offset += 4
			v4 = round32(v4, readUint32LE(bytes, offset))
			offset += 4
		}

		hash = (rotl32(v1, 1) + rotl32(v2, 7) + rotl32(v3, 12) + rotl32(v4, 18)) >>> 0
		hash = mergeRound32(hash, v1)
		hash = mergeRound32(hash, v2)
		hash = mergeRound32(hash, v3)
		hash = mergeRound32(hash, v4)
	} else {
		hash = (seed + PRIME32_5) >>> 0
	}

	hash = (hash + bytes.length) >>> 0

	while (offset <= bytes.length - 4) {
		hash = (hash + Math.imul(readUint32LE(bytes, offset), PRIME32_3)) >>> 0
		hash = rotl32(hash, 17)
		hash = Math.imul(hash, PRIME32_4) >>> 0
		offset += 4
	}

	while (offset < bytes.length) {
		hash = (hash + Math.imul(bytes[offset] ?? 0, PRIME32_5)) >>> 0
		hash = rotl32(hash, 11)
		hash = Math.imul(hash, PRIME32_1) >>> 0
		offset += 1
	}

	return avalanche32(hash)
}

/**
 * Bigram returned for lines that contain only whitespace and `{`/`}`.
 * Picks the English ordinal suffix for the line number (`1` → `st`,
 * `2` → `nd`, `3` → `rd`, `11`/`12`/`13` → `th`, else `th`) so the
 * line digits + bigram BPE-merge into a single ordinal token (`1st`, `42nd`,
 * `100th`, …). Brace-only lines therefore cost one token for the whole
 * `LINE+ID` anchor instead of two.
 */
export function structuralBigram(line: number): string {
	const mod100 = line % 100
	if (mod100 >= 11 && mod100 <= 13) return 'th'
	switch (line % 10) {
		case 1:
			return 'st'
		case 2:
			return 'nd'
		case 3:
			return 'rd'
		default:
			return 'th'
	}
}

/**
 * Compute a short BPE-bigram hash of a single line.
 *
 * Uses xxHash32 on a trailing-whitespace-trimmed, CR-stripped line, mapped into
 * {@link HASHLINE_BIGRAMS} via modulo. Lines that contain only whitespace and
 * `{`/`}` collapse to an ordinal-suffix bigram (see {@link structuralBigram})
 * so brace-only structure shares one merged ordinal token. For other lines
 * containing no alphanumeric characters, the line number is mixed in to reduce hash collisions.
 * The line input should not include a trailing newline.
 */
export function computeLineHash(idx: number, line: string): string {
	line = line.replace(/\r/g, '').trimEnd()

	if (line.replace(RE_STRUCTURAL_STRIP, '').length === 0) {
		return structuralBigram(idx)
	}

	let seed = 0
	if (!RE_SIGNIFICANT.test(line)) {
		seed = idx
	}
	return HASHLINE_BIGRAMS[xxHash32(line, seed) % HASHLINE_BIGRAMS_COUNT] ?? 'aa'
}

/**
 * Formats an anchor reference given a line number and its text.
 * Returns `LINE+ID` (e.g., `42nd`) — no separator between number and bigram.
 */
export function formatLineHash(line: number, lines: string): string {
	return `${line}${computeLineHash(line, lines)}`
}

/**
 * Formats a single line with a hashline anchor.
 * Returns `LINE+ID|TEXT` (e.g., `42nd|function hi() {\n2er|  return;\n3in|}`)
 */
export function formatHashLine(lineNumber: number, line: string): string {
	return `${lineNumber}${computeLineHash(lineNumber, line)}${HASHLINE_CONTENT_SEPARATOR}${line}`
}

/**
 * Format file text with hashline prefixes for display.
 *
 * Each line becomes `LINE+ID|TEXT` where LINENUM is 1-indexed.
 * No padding on line numbers; pipe separator between anchor and content.
 *
 * @param text - Raw file text string
 * @param startLine - First line number (1-indexed, defaults to 1)
 * @returns Formatted string with one hashline-prefixed line per input line
 *
 * @example
 * ```
 * formatHashLines("function hi() {\n  return;\n}")
 * // "1th|function hi() {\n2er|  return;\n3in|}"
 * ```
 */
export function formatHashLines(text: string, startLine = 1): string {
	const lines = text.split('\n')
	return lines.map((line, i) => formatHashLine(startLine + i, line)).join('\n')
}
