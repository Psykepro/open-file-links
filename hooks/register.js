// Appends open and copy buttons under assistant messages that name existing files
const PATH_RE = /(^|[\s`(\["'])((?:(?:~|\.)?(?:\/[\w.@+-]+)+|[\w.@+-]+(?:\/[\w.@+-]+)+))(?::(\d+))?(?::\d+)?(?=$|[\s`)\]"',.;:!?])/g
const exists = new Map()

// Collapse `.` and `..` segments so the editor and the root walk see a clean absolute path
function normalize(path) {
  const out = []
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return '/' + out.join('/')
}

// Nearest ancestor holding a root marker (OPEN_FILE_ROOT_MARKERS, comma list in priority order, default .git), else the file's folder
async function projectRoot($, file) {
  const start = file.slice(0, file.lastIndexOf('/')) || '/'
  const markers = String((await $.env.get('OPEN_FILE_ROOT_MARKERS')) || '.git').split(',').map((m) => m.trim()).filter(Boolean)
  for (const marker of markers) {
    let dir = start
    for (let i = 0; i < 40; i += 1) {
      if (await $.fs.exists(dir + '/' + marker)) return dir
      const up = dir.slice(0, dir.lastIndexOf('/'))
      if (!up || up === dir) break
      dir = up
    }
  }
  return start
}

// Command and code-block text by button id: keys use `|` as separator, commands contain it
const copyTexts = new Map()
const COPY_TEXTS_MAX = 500

function stash(id, text, label) {
  if (copyTexts.size >= COPY_TEXTS_MAX) copyTexts.delete(copyTexts.keys().next().value)
  copyTexts.set(id, { text, label })
}

// Id from the text itself: unique across blocks and renders, and the same text re-renders to the same id
function textId(prefix, text) {
  let h = 5381
  for (let i = 0; i < text.length; i += 1) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0
  return prefix + h.toString(36) + '.' + text.length
}

// Two or more words in an inline code span read as a command to copy whole, not a path
const isCommand = (span) => span.trim().split(/\s+/).length >= 2

let lastPress = { key: '', at: 0 }

async function openFile($, path, line) {
  const editor = (await $.env.get('OPEN_FILE_EDITOR')) || 'code'
  const root = await projectRoot($, path)
  const argv = [editor, root, '-g', line ? path + ':' + line : path]
  const r = await $.process.run(argv)
  if (r.exitCode !== 0) $.ui.toast('open failed: ' + (r.stderr || editor + ' exit ' + r.exitCode))
}

// Clipboard tools tried in order: macOS, Wayland, X11, Windows/WSL
const COPY_TOOLS = [['pbcopy'], ['wl-copy'], ['xclip', '-selection', 'clipboard'], ['clip.exe']]

async function copyText($, text, label) {
  const custom = (await $.env.get('OPEN_FILE_COPY_CMD')) || ''
  const tools = custom.trim() ? [custom.trim().split(/\s+/)] : COPY_TOOLS
  let last = 'no clipboard tool found'
  for (const argv of tools) {
    try {
      const r = await $.process.run(argv, { stdin: text })
      if (r.exitCode === 0) return $.ui.toast('copied ' + label)
      last = r.stderr || argv[0] + ' exit ' + r.exitCode
    } catch (err) {
      last = argv[0] + ': ' + (err && err.message ? err.message : err)
    }
  }
  $.ui.toast('copy failed: ' + last)
}

// Button keys carry the action: ofl|open|<abs>|<line>|<messageId>, ofl|copy|<abs>||<messageId>, ofl|cmd|<id>
async function press($, key) {
  const [, action, path, line] = key.split('|')
  const now = Date.now()
  if (lastPress.key === key && now - lastPress.at < 400) return
  lastPress = { key, at: now }
  if (action === 'open') await openFile($, path, line)
  else if (action === 'copy') await copyText($, path, path)
  else if (action === 'cmd') {
    const hit = copyTexts.get(path)
    if (hit === undefined) $.ui.toast('copy failed: message re-rendered, press again')
    else await copyText($, hit.text, hit.label)
  }
}

// Opening fence: 3+ backticks or tildes; a closing fence must match the character and be at least as long
const FENCE_RE = /^\s*(`{3,}|~{3,})(.*)$/
const MAX_SPAN_LINES = 40
// Lines that start a new block: an inline span never crosses one
const BLOCK_START_RE = /^\s*([-*+]\s|\d+[.)]\s|#{1,6}\s|>|\|)/

const tickRuns = (s) => [...s.matchAll(/`+/g)].map((m) => ({ pos: m.index, len: m[0].length }))

// Pair backtick runs on one line: a span closes on the next run of the same length; the rest open spans
function pairRuns(line) {
  const runs = tickRuns(line)
  const spans = []
  const open = []
  for (let i = 0; i < runs.length; i += 1) {
    const j = runs.findIndex((r, k) => k > i && r.len === runs[i].len)
    if (j < 0) open.push(runs[i])
    else { spans.push({ start: runs[i].pos, end: runs[j].pos + runs[j].len, body: line.slice(runs[i].pos + runs[i].len, runs[j].pos) }); i = j }
  }
  return { spans, open }
}

// Span opened by `opener` on lines[i] that closes on a later line of the same paragraph
function multilineSpan(lines, i, opener) {
  const parts = [lines[i].slice(opener.pos + opener.len)]
  for (let j = i + 1; j < lines.length && j - i <= MAX_SPAN_LINES; j += 1) {
    if (!lines[j].trim() || BLOCK_START_RE.test(lines[j]) || FENCE_RE.test(lines[j])) return null
    const same = tickRuns(lines[j]).filter((r) => r.len === opener.len)
    // an even count means the first run opens a span of its own, so it is not our closer
    if (same.length % 2 === 0 && same.length) return null
    const close = same[0]
    if (close) {
      parts.push(lines[j].slice(0, close.pos))
      return { end: j, body: parts.join('\n').trim() }
    }
    parts.push(lines[j])
  }
  return null
}

const noop = () => {}
// Theme key of the inline-code blue
const LINK_COLOR = 'permission'

export function register(on) {
  on('ui.press', { plugin: 'open-file-links' }, async ($, e, next) => {
    if (typeof e.element === 'string' && e.element.startsWith('ofl|')) await press($, e.element)
    return next(e)
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const text = e.props.text
    if (!text || !(text.includes('/') || text.includes('`') || text.includes('~~~'))) return next(e)
    const cwd = String(await $.session.cwd())
    const home = (await $.env.get('HOME')) || ''
    const lines = text.split('\n')
    const parsed = []
    let fence = null
    let any = false
    let fenceBody = []
        const addCopy = (body) => {
      if (!body.trim()) return null
      const id = textId('f', body)
      stash(id, body, 'text')
      any = true
      return { fence: id }
    }
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      let f = line.match(FENCE_RE)
      if (f && !fence && f[1][0] === '`' && f[2].includes('`')) f = null
      if (fence) {
        if (f && f[1][0] === fence.ch && f[1].length >= fence.len && !f[2].trim()) {
          parsed.push(addCopy(fenceBody.map((l) => l.slice(Math.min(fence.indent, l.length - l.trimStart().length))).join('\n')))
          fence = null
        } else { fenceBody.push(line); parsed.push(null) }
        continue
      }
      if (f) { fence = { ch: f[1][0], len: f[1].length, indent: line.length - line.trimStart().length }; fenceBody = []; parsed.push(null); continue }
      if (/^\s*\|/.test(line)) { parsed.push(null); continue }
      let span = null
      const paired = pairRuns(line)
      for (const opener of paired.open) {
        span = multilineSpan(lines, i, opener)
        if (span) break
      }
      if (span) {
        for (let k = i; k < span.end; k += 1) parsed.push(null)
        parsed.push(addCopy(span.body))
        i = span.end
        continue
      }
      const hits = []
      const cmdSpans = []
      for (const m of paired.spans) {
        if (!isCommand(m.body)) continue
        const id = textId('c', m.body.trim())
        stash(id, m.body.trim(), 'command')
        cmdSpans.push({ cmd: id, text: m.body, start: m.start, end: m.end })
      }
      hits.push(...cmdSpans)
      for (const m of line.matchAll(PATH_RE)) {
        const raw = m[2]
        const at = m.index + m[1].length
        if (cmdSpans.some((c) => at >= c.start && at < c.end)) continue
        const abs = normalize(raw.startsWith('~/') ? home + raw.slice(1) : raw.startsWith('/') ? raw : cwd + '/' + raw)
        if (abs.includes('|')) continue
        if (!exists.has(abs)) exists.set(abs, await $.fs.exists(abs))
        if (!exists.get(abs)) continue
        const line_ = m[3] || ''
        let start = m.index + m[1].length
        let end = start + raw.length + (line_ ? line_.length + 1 : 0)
        const label = line.slice(start, end)
        if (m[1] === '`' && line[end] === '`') { start -= 1; end += 1 }
        hits.push({ abs, line: line_, label, start, end })
      }
      hits.sort((a, b) => a.start - b.start)
      parsed.push(hits.length ? hits : null)
      if (hits.length) any = true
    }
    if (!any) return next(e)
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const blocks = []
    let md = []
    let n = 0
    const flush = () => {
      if (md.length) blocks.push(Markdown({ text: md.join('\n') }))
      md = []
    }
    const word = (t) => Text({ children: t })
    for (let i = 0; i < lines.length; i += 1) {
      const hits = parsed[i]
      if (!hits) { md.push(lines[i]); continue }
      if (!Array.isArray(hits)) {
        md.push(lines[i])
        flush()
        blocks.push(Button({ key: 'ofl|cmd|' + hits.fence, plain: true, onPress: noop,
          children: [Text({ color: LINK_COLOR, children: ' ⧉ copy ' })] }))
        continue
      }
      flush()
      const items = []
      let at = 0
      for (const h of hits) {
        if (h.cmd) {
          for (const t of lines[i].slice(at, h.start).split(/(?<=\s)/).filter(Boolean)) items.push(word(t))
          for (const t of h.text.split(/(?<=\s)/).filter(Boolean)) items.push(Text({ color: LINK_COLOR, children: t }))
          items.push(word(' '))
          items.push(Button({ key: 'ofl|cmd|' + h.cmd, plain: true, onPress: noop,
            children: [Text({ color: LINK_COLOR, children: ' ⧉ ' })] }))
          at = h.end
          continue
        }
        for (const t of lines[i].slice(at, h.start).split(/(?<=\s)/).filter(Boolean)) items.push(word(t))
        n += 1
        items.push(Button({ key: 'ofl|open|' + h.abs + '|' + h.line + '|' + e.requestId + '|' + n, plain: true, onPress: noop,
          children: [Text({ color: LINK_COLOR, children: '↗ ' + h.label })] }))
        items.push(word(' '))
        items.push(Button({ key: 'ofl|copy|' + h.abs + '||' + e.requestId + '|' + n, plain: true, onPress: noop,
          children: [Text({ color: LINK_COLOR, children: ' ⧉ ' })] }))
        at = h.end
      }
      for (const t of lines[i].slice(at).split(/(?<=\s)/).filter(Boolean)) items.push(word(t))
      blocks.push(Box({ flexDirection: 'row', flexWrap: 'wrap', children: items }))
    }
    flush()
    const body = Box({ flexDirection: 'column', flexGrow: 1, children: blocks })
    return Box({ flexDirection: 'row', children: [Text({ children: e.props.isFirstOfReply ? '⏺ ' : '  ' }), body] })
  })
}
