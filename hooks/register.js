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

function stash(id, text) {
  if (copyTexts.size >= COPY_TEXTS_MAX) copyTexts.clear()
  copyTexts.set(id, text)
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
    const text = copyTexts.get(path)
    if (text === undefined) $.ui.toast('copy failed: message re-rendered, press again')
    else await copyText($, text, 'command')
  }
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
    if (!text || !text.includes('/')) return next(e)
    const cwd = String(await $.session.cwd())
    const home = (await $.env.get('HOME')) || ''
    const lines = text.split('\n')
    const parsed = []
    let fenced = false
    let any = false
    let fenceBody = []
    let uid = 0
    for (const line of lines) {
      if (/^\s*```/.test(line)) {
        if (fenced && fenceBody.length) {
          const id = e.requestId + ':f' + (uid += 1)
          stash(id, fenceBody.join('\n'))
          parsed.push({ fence: id })
          any = true
        } else parsed.push(null)
        fenced = !fenced
        fenceBody = []
        continue
      }
      if (fenced) { fenceBody.push(line); parsed.push(null); continue }
      if (/^\s*\|/.test(line)) { parsed.push(null); continue }
      const hits = []
      const cmdSpans = []
      for (const m of line.matchAll(/`([^`]+)`/g)) {
        if (!isCommand(m[1])) continue
        const id = e.requestId + ':c' + (uid += 1)
        stash(id, m[1].trim())
        cmdSpans.push({ cmd: id, text: m[1], start: m.index, end: m.index + m[0].length })
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
