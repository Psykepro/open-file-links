import { expect, test } from 'claude-code/testing'

const MSG = (text: string) => ({
  plugin: 'open-file-links',
  component: 'AssistantMessage',
  requestId: 'm1',
  surface: 'terminal',
  viewport: { columns: 100, rows: 30 },
  props: { text, isFirstOfReply: true },
}) as const

function stubs(on: any, existing: string[], runs: any[] = [], envs: Record<string, string> = {}, failing: string[] = []) {
  on('session.cwd', () => ({ value: '/work' }))
  on('env.get', ($: any, e: any) => ({ value: e.name === 'HOME' ? '/home/u' : envs[e.name] }))
  on('fs.exists', ($: any, e: any) => ({ value: existing.includes(e.path) }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['native'] }))
  on('process.run', ($: any, e: any) => {
    runs.push({ argv: [...e.argv], stdin: e.init?.stdin })
    const bad = failing.includes(e.argv[0])
    return { value: { exitCode: bad ? 127 : 0, stdout: '', stderr: bad ? 'not found' : '' } }
  })
}

const keyOf = (b: any) => b.props.key as string
const buttons = async (ui: any) => (await ui.findAll({ type: 'Button' })).map(keyOf) as string[]
const pressKey = async (ui: any, action: string, path: string) => {
  const key = (await buttons(ui)).find((k) => k.startsWith(`ofl|${action}|${path}|`))
  if (!key) throw new Error(`no ${action} button for ${path}`)
  await ui.press({ key })
}

test('existing absolute, relative and ~ paths become open and copy buttons in the sentence', async ($, on) => {
  stubs(on, ['/abs/a.py', '/work/src/b.ts', '/home/u/c.md'])
  const ui = await $.ui.mount(MSG('See `/abs/a.py:12`, src/b.ts and ~/c.md now. Missing /nope/x.py stays.'))
  const keys = await buttons(ui)
  expect(keys.some((k) => k.startsWith('ofl|open|/abs/a.py|12|m1|'))).toBe(true)
  expect(keys.some((k) => k.startsWith('ofl|copy|/abs/a.py||m1|'))).toBe(true)
  expect(keys.some((k) => k.startsWith('ofl|open|/work/src/b.ts||m1|'))).toBe(true)
  expect(keys.some((k) => k.startsWith('ofl|open|/home/u/c.md||m1|'))).toBe(true)
  expect(keys.some((k) => k.includes('/nope/'))).toBe(false)
  expect(await ui.find({ type: 'Text', text: '↗ /abs/a.py:12' })).toBeDefined()
})

test('no existing path leaves the native drawing alone', async ($, on) => {
  stubs(on, [])
  const ui = await $.ui.mount(MSG('plain /nope/x.py text'))
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'native' })).toBeDefined()
})

test('table rows get no buttons and fenced code gets no open buttons', async ($, on) => {
  stubs(on, ['/abs/a.py'])
  const ui = await $.ui.mount(MSG('```\n/abs/a.py\n```\n| x | /abs/a.py |'))
  const keys = await buttons(ui)
  expect(keys.filter((k) => k.startsWith('ofl|open|') || k.startsWith('ofl|copy|')).length).toBe(0)
  expect(keys.length).toBe(1)
})

test('lines without paths stay markdown', async ($, on) => {
  stubs(on, ['/abs/a.py'])
  const ui = await $.ui.mount(MSG('**intro**\n/abs/a.py\noutro'))
  expect((await ui.findAll({ type: 'Markdown' })).length).toBe(2)
})

test('the same path twice gets distinct buttons', async ($, on) => {
  stubs(on, ['/abs/a.py'])
  const ui = await $.ui.mount(MSG('/abs/a.py and again /abs/a.py'))
  expect(new Set(await buttons(ui)).size).toBe(4)
})

test('open runs the editor from the root named by OPEN_FILE_ROOT_MARKERS with the line', async ($, on) => {
  const runs: any[] = []
  stubs(on, ['/proj/src/a.py', '/proj/pnpm-workspace.yaml', '/proj/src/.git'], runs, { OPEN_FILE_ROOT_MARKERS: 'pnpm-workspace.yaml,.git' })
  const ui = await $.ui.mount(MSG('see /proj/src/a.py:7'))
  await pressKey(ui, 'open', '/proj/src/a.py')
  expect(runs.map((r) => r.argv)).toEqual([['code', '/proj', '-g', '/proj/src/a.py:7']])
})

test('open falls back to the git root, then the file folder', async ($, on) => {
  const runs: any[] = []
  stubs(on, ['/g/src/a.py', '/g/.git', '/solo/b.py'], runs)
  const ui = await $.ui.mount(MSG('/g/src/a.py and /solo/b.py'))
  await pressKey(ui, 'open', '/g/src/a.py')
  await pressKey(ui, 'open', '/solo/b.py')
  expect(runs.map((r) => r.argv)).toEqual([['code', '/g', '-g', '/g/src/a.py'], ['code', '/solo', '-g', '/solo/b.py']])
})

test('copy puts the absolute path on the clipboard', async ($, on) => {
  const runs: any[] = []
  stubs(on, ['/abs/a.py'], runs)
  const ui = await $.ui.mount(MSG('/abs/a.py'))
  await pressKey(ui, 'copy', '/abs/a.py')
  expect(runs).toEqual([{ argv: ['pbcopy'], stdin: '/abs/a.py' }])
})

test('every press works: open, copy, open again', async ($, on) => {
  const runs: any[] = []
  stubs(on, ['/abs/a.py', '/abs/b.py'], runs)
  const ui = await $.ui.mount(MSG('/abs/a.py /abs/b.py'))
  await pressKey(ui, 'open', '/abs/a.py')
  await pressKey(ui, 'copy', '/abs/b.py')
  await pressKey(ui, 'open', '/abs/b.py')
  expect(runs.length).toBe(3)
})

test('relative paths with .. are normalized', async ($, on) => {
  stubs(on, ['/other/x/y.ts', '/work/src/a.ts'])
  const ui = await $.ui.mount(MSG('see ../other/x/y.ts and ./src/a.ts'))
  const keys = await buttons(ui)
  expect(keys.some((k) => k.startsWith('ofl|open|/other/x/y.ts||'))).toBe(true)
  expect(keys.some((k) => k.startsWith('ofl|open|/work/src/a.ts||'))).toBe(true)
})

test('without markers set, only .git marks a root', async ($, on) => {
  const runs: any[] = []
  stubs(on, ['/proj/src/a.py', '/proj/docs-marker'], runs)
  const ui = await $.ui.mount(MSG('/proj/src/a.py'))
  await pressKey(ui, 'open', '/proj/src/a.py')
  expect(runs.map((r) => r.argv)).toEqual([['code', '/proj/src', '-g', '/proj/src/a.py']])
})

test('copy falls back to the next clipboard tool when one is missing', async ($, on) => {
  const runs: any[] = []
  stubs(on, ['/abs/a.py'], runs, {}, ['pbcopy'])
  const ui = await $.ui.mount(MSG('/abs/a.py'))
  await pressKey(ui, 'copy', '/abs/a.py')
  expect(runs.map((r) => r.argv)).toEqual([['pbcopy'], ['wl-copy']])
})

test('OPEN_FILE_COPY_CMD overrides the clipboard tool', async ($, on) => {
  const runs: any[] = []
  stubs(on, ['/abs/a.py'], runs, { OPEN_FILE_COPY_CMD: 'my-clip --stdin' })
  const ui = await $.ui.mount(MSG('/abs/a.py'))
  await pressKey(ui, 'copy', '/abs/a.py')
  expect(runs).toEqual([{ argv: ['my-clip', '--stdin'], stdin: '/abs/a.py' }])
})

const CMD = '! cd /abs/wt && make vpn-add T=https://x.io BASE="$HOME/a (3).ovpn" && make s | grep -E "k|z"'

test('an inline command with a path gets one copy button for the whole command and no open button', async ($, on) => {
  const runs: any[] = []
  stubs(on, ['/abs/wt'], runs)
  const ui = await $.ui.mount(MSG('Run this:\n`' + CMD + '`\nthen reload'))
  const keys = await buttons(ui)
  expect(keys.filter((k) => k.startsWith('ofl|open|')).length).toBe(0)
  const copies = keys.filter((k) => k.startsWith('ofl|cmd|'))
  expect(copies.length).toBe(1)
  await ui.press({ key: copies[0] })
  expect(runs).toEqual([{ argv: ['pbcopy'], stdin: CMD }])
})

test('a backticked lone path still gets open and copy buttons', async ($, on) => {
  stubs(on, ['/abs/a.py'])
  const ui = await $.ui.mount(MSG('see `/abs/a.py` now'))
  const keys = await buttons(ui)
  expect(keys.some((k) => k.startsWith('ofl|open|/abs/a.py|'))).toBe(true)
  expect(keys.some((k) => k.startsWith('ofl|cmd|'))).toBe(false)
})

test('a fenced block gets one copy button for its whole body', async ($, on) => {
  const runs: any[] = []
  stubs(on, ['/abs/wt'], runs)
  const ui = await $.ui.mount(MSG('go:\n```sh\ncd /abs/wt\nmake x | grep y\n```\ndone'))
  const keys = await buttons(ui)
  expect(keys.filter((k) => k.startsWith('ofl|open|')).length).toBe(0)
  const copies = keys.filter((k) => k.startsWith('ofl|cmd|'))
  expect(copies.length).toBe(1)
  await ui.press({ key: copies[0] })
  expect(runs).toEqual([{ argv: ['pbcopy'], stdin: 'cd /abs/wt\nmake x | grep y' }])
})

const copyBtns = async (ui: any) => (await buttons(ui)).filter((k) => k.startsWith('ofl|cmd|'))

test('a fenced text block with no path in the message still gets a copy button', async ($, on) => {
  const runs: any[] = []
  stubs(on, [], runs)
  const ui = await $.ui.mount(MSG('Slack:\n```\nHi team,\nrelease is out.\n```'))
  const copies = await copyBtns(ui)
  expect(copies.length).toBe(1)
  await ui.press({ key: copies[0] })
  expect(runs).toEqual([{ argv: ['pbcopy'], stdin: 'Hi team,\nrelease is out.' }])
})

test('a tilde fence gets a copy button', async ($, on) => {
  const runs: any[] = []
  stubs(on, [], runs)
  const ui = await $.ui.mount(MSG('~~~text\nline one\nline two\n~~~'))
  const copies = await copyBtns(ui)
  expect(copies.length).toBe(1)
  await ui.press({ key: copies[0] })
  expect(runs[0].stdin).toBe('line one\nline two')
})

test('a longer fence keeps an inner shorter fence as body text', async ($, on) => {
  const runs: any[] = []
  stubs(on, [], runs)
  const ui = await $.ui.mount(MSG('````md\n```sh\nmake x\n```\n````\nafter'))
  const copies = await copyBtns(ui)
  expect(copies.length).toBe(1)
  await ui.press({ key: copies[0] })
  expect(runs[0].stdin).toBe('```sh\nmake x\n```')
})

test('an inline backtick span over several lines is copied whole', async ($, on) => {
  const runs: any[] = []
  stubs(on, [], runs)
  const ui = await $.ui.mount(MSG('Send `Hi all,\nthe build is green.\nThanks` to the channel'))
  const copies = await copyBtns(ui)
  expect(copies.length).toBe(1)
  await ui.press({ key: copies[0] })
  expect(runs[0].stdin).toBe('Hi all,\nthe build is green.\nThanks')
})

test('a stray backtick before a blank line does not swallow the rest', async ($, on) => {
  stubs(on, [])
  const ui = await $.ui.mount(MSG('it`s odd\n\nlater `a b` here'))
  expect((await copyBtns(ui)).length).toBe(1)
})

test('a fenced block of whitespace only gets no button', async ($, on) => {
  stubs(on, [])
  const ui = await $.ui.mount(MSG('```\n\n```'))
  expect((await copyBtns(ui)).length).toBe(0)
})
