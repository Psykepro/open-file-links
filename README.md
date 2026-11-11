# open-file-links

Click a file path in Claude Code's terminal output and it opens in your editor at the right line. Copy any path, command or code block with one button instead of selecting it by hand.

> Part of the upcoming **Agentic Engineering Operating System (AEOS)**, a toolkit for working with coding agents that I'm building and will release. This plugin works on its own today.

## Install

```
/plugin install open-file-links --marketplace Psykepro/open-file-links
```

Or from a shell: `claude plugin marketplace add Psykepro/open-file-links`, then `claude plugin install open-file-links@open-file-links`. Needs a Claude Code version with terminal mod support.

## Behavior

- Matches absolute, `~/`, and relative paths with a `/` (`src/a.ts`, `../x/y.py`), optionally `:line`. Relative paths resolve against the session working directory.
- Only paths that exist get buttons. Table rows are left as text.
- An inline code span with two or more words (a command) gets no path buttons; it shows as written with one `⧉` button that copies the whole command, pipes and quotes included.
- A fenced code block gets one `⧉ copy` button under it that copies the whole body.
- Open runs `<editor> <project root> -g <file>[:line]`.
- Copy tries `pbcopy`, `wl-copy`, `xclip -selection clipboard`, then `clip.exe`; the first that succeeds wins.

## Settings (environment variables)

| variable | default | meaning |
|---|---|---|
| `OPEN_FILE_EDITOR` | `code` | editor command; must accept `<root> -g <file>:<line>` (VS Code, Cursor, Windsurf, VSCodium) |
| `OPEN_FILE_ROOT_MARKERS` | `.git` | comma list of file/folder names marking a project root, tried in order; no match opens the file's folder |
| `OPEN_FILE_COPY_CMD` | unset | clipboard command (reads the path on stdin), replaces the built-in list, e.g. `xsel -ib` |

## What it runs and what it sends

- **Reads:** the text of assistant messages (to find file paths and commands) and checks on disk whether each path exists. Nothing else is read.
- **Runs, on a button press only:** your editor (`OPEN_FILE_EDITOR`, default `code`) as `<editor> <project root> -g <file>[:line]`, and a clipboard tool (`pbcopy`, `wl-copy`, `xclip -selection clipboard`, `clip.exe`, or the command you set in `OPEN_FILE_COPY_CMD`) with the path or command text on stdin. The editor and clipboard commands come only from those fixed names and your own environment variables; no other program is started.
- **Sends:** nothing. The mod makes no network calls, has no telemetry and stores nothing. Data leaves the mod only as the text handed to your own clipboard tool or the path handed to your own editor.

## License

MIT
