/**
 * FileIcon — Material-Icon-Theme style file-type icons for riven.
 *
 * Fully self-contained: every glyph is inline SVG (viewBox 0 0 16 16),
 * no external assets, no network, no dependencies. Colors are hard-coded
 * brand-ish hexes tuned for riven's near-black surfaces; the generic file
 * glyph uses `currentColor` so it follows the row's foreground color.
 */

const FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif"

/* ---- shared glyph builders ------------------------------------------------ */

function Badge({
  bg,
  label,
  fg = '#fff',
  fs = 7
}: {
  bg: string
  label: string
  fg?: string
  fs?: number
}): JSX.Element {
  return (
    <>
      <rect x="1" y="1" width="14" height="14" rx="3" fill={bg} />
      <text
        x="8"
        y="8.4"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={fs}
        fontWeight={700}
        fontFamily={FONT}
        fill={fg}
      >
        {label}
      </text>
    </>
  )
}

/** Bare colored "#" — the Material css/scss/less mark. */
function Hash({ color }: { color: string }): JSX.Element {
  return (
    <text
      x="8"
      y="8.6"
      textAnchor="middle"
      dominantBaseline="central"
      fontSize={13}
      fontWeight={700}
      fontFamily={FONT}
      fill={color}
    >
      #
    </text>
  )
}

/** React atom (used for jsx/tsx in different colors). */
function Atom({ color }: { color: string }): JSX.Element {
  return (
    <g stroke={color} strokeWidth="1" fill="none">
      <circle cx="8" cy="8" r="1.6" fill={color} stroke="none" />
      <ellipse cx="8" cy="8" rx="6.4" ry="2.5" />
      <ellipse cx="8" cy="8" rx="6.4" ry="2.5" transform="rotate(60 8 8)" />
      <ellipse cx="8" cy="8" rx="6.4" ry="2.5" transform="rotate(120 8 8)" />
    </g>
  )
}

/** "< >" angle brackets, optional center slash (html vs xml). */
function CodeTag({ color, slash }: { color: string; slash?: boolean }): JSX.Element {
  return (
    <g fill={color}>
      <path d="M5.3 4.2L1.6 8l3.7 3.8 1.1-1.1L3.8 8l2.6-2.7z" />
      <path d="M10.7 4.2L14.4 8l-3.7 3.8-1.1-1.1L12.2 8 9.6 5.3z" />
      {slash && <path d="M8.8 3.4h1.5L7.2 12.6H5.7z" />}
    </g>
  )
}

/* ---- the icon table -------------------------------------------------------- */

const ICONS = {
  /* folders */
  folder: (
    <path
      d="M.7 12.6V3.7a1 1 0 011-1h4.1l1.5 1.6h6.9a1 1 0 011 1v7.3a1 1 0 01-1 1H1.7a1 1 0 01-1-1z"
      fill="#8bb3d9"
    />
  ),
  folderOpen: (
    <>
      <path
        d="M1.7 2.7h4.1l1.5 1.6h6.4a1 1 0 011 1v1.2H3l-2.3 6V3.7a1 1 0 011-1z"
        fill="#6f94ba"
      />
      <path
        d="M3 6.5h11.9a.7.7 0 01.66.93l-1.95 5.5a1 1 0 01-.94.67H.9z"
        fill="#8bb3d9"
      />
    </>
  ),

  /* generic */
  file: (
    <path
      fill="currentColor"
      d="M9.5 1H4a1 1 0 00-1 1v12a1 1 0 001 1h8a1 1 0 001-1V4.5L9.5 1zM9 5V2l3 3H9z"
    />
  ),

  /* languages */
  ts: <Badge bg="#3178c6" label="TS" />,
  tsx: <Atom color="#3178c6" />,
  js: <Badge bg="#f5de19" fg="#2b2b2b" label="JS" />,
  jsx: <Atom color="#61dafb" />,
  json: (
    <text
      x="8"
      y="8.6"
      textAnchor="middle"
      dominantBaseline="central"
      fontSize={11}
      fontWeight={700}
      fontFamily={FONT}
      fill="#fbc02d"
    >
      {'{ }'}
    </text>
  ),
  css: <Hash color="#42a5f5" />,
  scss: <Hash color="#f06292" />,
  less: <Hash color="#7986cb" />,
  html: <CodeTag color="#e44d26" slash />,
  xml: <CodeTag color="#ffb300" />,
  md: (
    <>
      <rect x="0.5" y="3.2" width="15" height="9.6" rx="1.6" fill="#42a5f5" />
      <path
        fill="#fff"
        d="M2.5 10.4V5.6h1.6L6 8l1.9-2.4h1.6v4.8H7.8V8.1L6 10.3 4.2 8.1v2.3z"
      />
      <path fill="#fff" d="M12.1 5.6h1.7v2.5h1.5L13 10.9l-2.4-2.8h1.5z" />
    </>
  ),
  py: (
    <>
      <g>
        <path
          fill="#4584b6"
          d="M8 1.2c-2.1 0-3.3.9-3.3 2.4v1.2h3.4v.7H3.9c-1.6 0-2.8 1.1-2.8 2.8 0 1.6 1.1 2.7 2.6 2.7h1.4V9.3c0-1.5 1.2-2.7 2.7-2.7h2.6c1.2 0 2.2-1 2.2-2.2V3.6c0-1.4-1.5-2.4-3.5-2.4z"
        />
        <circle cx="6.2" cy="3" r="0.8" fill="#fff" />
      </g>
      <g transform="rotate(180 8 8)">
        <path
          fill="#ffd43b"
          d="M8 1.2c-2.1 0-3.3.9-3.3 2.4v1.2h3.4v.7H3.9c-1.6 0-2.8 1.1-2.8 2.8 0 1.6 1.1 2.7 2.6 2.7h1.4V9.3c0-1.5 1.2-2.7 2.7-2.7h2.6c1.2 0 2.2-1 2.2-2.2V3.6c0-1.4-1.5-2.4-3.5-2.4z"
        />
        <circle cx="6.2" cy="3" r="0.8" fill="#fff" />
      </g>
    </>
  ),
  rs: (
    <>
      <circle cx="8" cy="8" r="6.8" fill="#ef6c30" />
      <text
        x="8"
        y="8.4"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={8.5}
        fontWeight={700}
        fontFamily={FONT}
        fill="#fff"
      >
        R
      </text>
    </>
  ),
  go: <Badge bg="#00acd7" label="GO" fs={6.5} />,
  java: (
    <>
      <path
        d="M3.5 8h8v3.2A2.8 2.8 0 018.7 14H6.3a2.8 2.8 0 01-2.8-2.8z"
        fill="#e76f00"
      />
      <path
        d="M11.5 9h1.2a1.6 1.6 0 010 3.2h-1.4"
        fill="none"
        stroke="#e76f00"
        strokeWidth="1.2"
      />
      <g stroke="#f89820" strokeWidth="1.1" strokeLinecap="round" fill="none">
        <path d="M6.4 6.4c-1-1 1-1.7 0-3.2" />
        <path d="M9 6.4c-1-1 1-1.7 0-3.2" />
      </g>
    </>
  ),
  c: <Badge bg="#0277bd" label="C" fs={8.5} />,
  cpp: <Badge bg="#0288d1" label="C++" fs={6} />,
  h: <Badge bg="#7e57c2" label="H" fs={8} />,
  sh: (
    <>
      <rect x="1" y="2.5" width="14" height="11" rx="1.8" fill="#37474f" />
      <path
        d="M3.6 6l2.3 2-2.3 2"
        fill="none"
        stroke="#89e051"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M7.4 10.6h3.8" stroke="#89e051" strokeWidth="1.4" strokeLinecap="round" />
    </>
  ),
  yaml: (
    <g fill="#ff5252">
      <rect x="1.5" y="3" width="2.6" height="1.6" rx="0.5" />
      <rect x="5.3" y="3" width="9.2" height="1.6" rx="0.5" />
      <rect x="1.5" y="7.2" width="2.6" height="1.6" rx="0.5" />
      <rect x="5.3" y="7.2" width="9.2" height="1.6" rx="0.5" />
      <rect x="1.5" y="11.4" width="2.6" height="1.6" rx="0.5" />
      <rect x="5.3" y="11.4" width="6" height="1.6" rx="0.5" />
    </g>
  ),
  toml: <Badge bg="#9c4221" label="T" fs={8.5} />,
  sql: (
    <>
      <path
        d="M2.5 3.6v8.8c0 1.2 2.5 2.1 5.5 2.1s5.5-.9 5.5-2.1V3.6"
        fill="#ffca28"
      />
      <ellipse cx="8" cy="3.6" rx="5.5" ry="2.1" fill="#ffd54f" />
      <path
        d="M2.5 6.9c0 1.2 2.5 2.1 5.5 2.1s5.5-.9 5.5-2.1"
        fill="none"
        stroke="#c79100"
        strokeWidth="0.9"
      />
      <path
        d="M2.5 9.9c0 1.2 2.5 2.1 5.5 2.1s5.5-.9 5.5-2.1"
        fill="none"
        stroke="#c79100"
        strokeWidth="0.9"
      />
    </>
  ),
  svg: (
    <>
      <path
        d="M3 12.5C5.2 4.5 10.8 11.5 13 3.8"
        fill="none"
        stroke="#ffb13b"
        strokeWidth="1.4"
      />
      <rect x="1.6" y="11.1" width="2.8" height="2.8" fill="#ffb13b" />
      <rect x="11.6" y="2.4" width="2.8" height="2.8" fill="#ffb13b" />
    </>
  ),
  image: (
    <>
      <rect x="1" y="2.5" width="14" height="11" rx="1.5" fill="#26a69a" />
      <circle cx="5.2" cy="6" r="1.5" fill="#ffee58" />
      <path d="M3 13.5l3.6-4.5 2.4 2.6 2-2.2 3.5 4.1z" fill="#00695c" />
    </>
  ),
  lock: (
    <>
      <path
        d="M5.2 7.2V5.4a2.8 2.8 0 015.6 0v1.8"
        fill="none"
        stroke="#b0bec5"
        strokeWidth="1.5"
      />
      <rect x="3.4" y="7" width="9.2" height="7.4" rx="1.4" fill="#ffca28" />
      <circle cx="8" cy="10" r="1.2" fill="#795548" />
      <rect x="7.4" y="10.6" width="1.2" height="2" rx="0.6" fill="#795548" />
    </>
  ),
  env: (
    <>
      <g stroke="#fdd835" strokeWidth="1.3" strokeLinecap="round">
        <path d="M2 4.2h12" />
        <path d="M2 8h12" />
        <path d="M2 11.8h12" />
      </g>
      <g fill="#fdd835" stroke="#15161a" strokeWidth="1">
        <circle cx="10.5" cy="4.2" r="1.9" />
        <circle cx="5.5" cy="8" r="1.9" />
        <circle cx="11.5" cy="11.8" r="1.9" />
      </g>
    </>
  ),
  git: (
    <g fill="#e84e31">
      <path d="M4.7 5.4v5.6" stroke="#e84e31" strokeWidth="1.4" />
      <path
        d="M11.6 7.2c0 2.6-2.6 3.4-6 3.7"
        fill="none"
        stroke="#e84e31"
        strokeWidth="1.4"
      />
      <circle cx="4.7" cy="3.6" r="1.8" />
      <circle cx="4.7" cy="12.4" r="1.8" />
      <circle cx="11.6" cy="5.4" r="1.8" />
    </g>
  ),
  docker: (
    <g fill="#2396ed">
      <rect x="1.8" y="6.2" width="2.3" height="2.1" />
      <rect x="4.5" y="6.2" width="2.3" height="2.1" />
      <rect x="7.2" y="6.2" width="2.3" height="2.1" />
      <rect x="4.5" y="3.7" width="2.3" height="2.1" />
      <path d="M.7 9.2h14.6c-.6 2.9-3 4.6-6.7 4.6-3.9 0-6.7-1.7-7.9-4.6z" />
    </g>
  ),

  /* well-known full names */
  npm: (
    <>
      <rect x="1" y="1" width="14" height="14" rx="3" fill="#cb3837" />
      <path d="M3.5 5h9v6H9.1V7.3H7.4V11H3.5z" fill="#fff" />
    </>
  ),
  tsconfig: (
    <>
      <rect x="1" y="1" width="14" height="14" rx="3" fill="#3178c6" />
      <text
        x="6.7"
        y="6.6"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={6.5}
        fontWeight={700}
        fontFamily={FONT}
        fill="#fff"
      >
        TS
      </text>
      <g fill="#fff">
        <circle cx="11.6" cy="11.6" r="2.2" />
        <rect x="11" y="8.7" width="1.2" height="5.8" />
        <rect x="8.7" y="11" width="5.8" height="1.2" />
      </g>
      <circle cx="11.6" cy="11.6" r="1" fill="#3178c6" />
    </>
  ),
  readme: (
    <>
      <circle cx="8" cy="8" r="6.6" fill="#29b6f6" />
      <circle cx="8" cy="4.9" r="1.1" fill="#fff" />
      <rect x="7.1" y="6.8" width="1.8" height="5" rx="0.9" fill="#fff" />
    </>
  ),
  license: (
    <>
      <path d="M5.7 8.4l-1.3 5.2 2-.9.9 1.8 1.4-4.6z" fill="#ef5350" />
      <path d="M10.3 8.4l1.3 5.2-2-.9-.9 1.8-1.4-4.6z" fill="#ef5350" />
      <circle cx="8" cy="5.6" r="4.2" fill="#ffca28" />
      <circle cx="8" cy="5.6" r="2.3" fill="#f9a825" />
    </>
  )
} as const

type IconId = keyof typeof ICONS

/* ---- name → icon resolution ------------------------------------------------ */

const NAMES: Record<string, IconId> = {
  'package.json': 'npm',
  'tsconfig.json': 'tsconfig',
  'jsconfig.json': 'tsconfig',
  'package-lock.json': 'lock',
  'yarn.lock': 'lock',
  'pnpm-lock.yaml': 'lock',
  'cargo.lock': 'lock',
  'readme.md': 'readme',
  'readme': 'readme',
  'license': 'license',
  'licence': 'license',
  'license.md': 'license',
  'license.txt': 'license',
  'dockerfile': 'docker',
  '.gitignore': 'git',
  '.gitattributes': 'git',
  '.gitmodules': 'git',
  '.env': 'env'
}

const EXTS: Record<string, IconId> = {
  ts: 'ts',
  mts: 'ts',
  cts: 'ts',
  tsx: 'tsx',
  js: 'js',
  mjs: 'js',
  cjs: 'js',
  jsx: 'jsx',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  css: 'css',
  scss: 'scss',
  sass: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  md: 'md',
  markdown: 'md',
  mdx: 'md',
  py: 'py',
  pyw: 'py',
  rs: 'rs',
  go: 'go',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  h: 'h',
  sh: 'sh',
  bash: 'sh',
  zsh: 'sh',
  fish: 'sh',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  sql: 'sql',
  svg: 'svg',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  ico: 'image',
  bmp: 'image',
  avif: 'image',
  lock: 'lock',
  env: 'env'
}

function iconIdFor(name: string): IconId {
  const n = name.toLowerCase()
  const known = NAMES[n]
  if (known) return known
  if (n.startsWith('tsconfig') && n.endsWith('.json')) return 'tsconfig'
  if (n === 'dockerfile' || n.startsWith('dockerfile.') || n.startsWith('docker-compose'))
    return 'docker'
  if (n.startsWith('.git')) return 'git'
  if (n.startsWith('.env.')) return 'env'
  if (n.startsWith('readme.')) return 'readme'
  if (n.endsWith('.lock')) return 'lock'
  const dot = n.lastIndexOf('.')
  if (dot > 0) {
    const byExt = EXTS[n.slice(dot + 1)]
    if (byExt) return byExt
  }
  return 'file'
}

/* ---- component -------------------------------------------------------------- */

export function FileIcon({
  name,
  dir,
  open,
  size = 16
}: {
  name: string
  dir?: boolean
  open?: boolean
  size?: number
}): JSX.Element {
  const id: IconId = dir ? (open ? 'folderOpen' : 'folder') : iconIdFor(name)
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {ICONS[id]}
    </svg>
  )
}
