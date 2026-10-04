# Monk

A minimal macOS terminal app built for running Claude Code across multiple projects.

- **Left sidebar**: your project folders. Click one to switch to its terminal. Add projects by dragging a folder from Finder onto the sidebar, or with the + button. Drag rows up and down to reorder them.
- **Right**: a real terminal (zsh login shell) opened in that project's folder. Each project keeps its own shell alive while you switch between them.
- **Launch Claude** button runs `claude` in the active project.
- **Drop a file on the terminal** to paste its path, quoted for the shell. HEIC images are converted to JPEG first (Claude Code can't read HEIC); the copies live in `~/Library/Application Support/Monk/converted/`.

## Model and usage display

The title bar shows the model of the newest Claude Code session for the active project (dimmed when that session is more than 30 minutes old or the model is only known from settings). Below it, a stats bar shows:

- **Context**: tokens in the last reply's context versus the window (1M for `[1m]` models, else 200K). Hatched at 80%+.
- **Budget**: Claude Code's per-session token budget, from its `total_tokens` reminders.
- **Session**: cumulative input and output tokens across the session.

All of this is read from `~/.claude/projects/<project>/<session>.jsonl`, scanned incrementally every 3 seconds.

## Run

```sh
npm install   # first time only; compiles node-pty for Electron
npm start
```

## Install as a Mac app (Spotlight / Dock)

```sh
npm run install-app
```

This packages the app with its icon and copies it to `/Applications/Monk.app`.
Spotlight picks it up automatically. Re-run after making changes to update the installed copy.

The app icon is a square crop of Philip Guston's *Painting, Smoking, Eating* (1973), stored as `build/icon-source.jpg`. `build/icon.svg` masks it into the macOS rounded tile, and `npm run icon` renders `build/icon.icns` from that with a transparent background.

## Design

Warm sand background, near-black text, Space Mono, straight 1px rules, no rounded corners. All colors and sizes are CSS variables at the top of `src/renderer/style.css`; the terminal palette is `THEME` in `src/renderer/renderer.js`. Space Mono is bundled in `src/renderer/fonts/` under the SIL Open Font License.

## Shortcuts

| Keys        | Action                     |
|-------------|----------------------------|
| Cmd+N       | Add a project folder       |
| Cmd+1 .. 9  | Switch to the Nth project  |

## Debugging

```sh
CT_DEBUG=1 npm start                          # forwards renderer console + pty events to stdout
CT_DEBUG=1 CT_SCREENSHOT=/tmp/shot.png npm start   # also saves a screenshot 2.5s after load
CT_DEBUG=1 CT_EVAL="projects.length" npm start     # runs JS in the renderer after load and logs the result
```

Projects are stored in `~/Library/Application Support/Monk/projects.json`. On first launch, lists from earlier app names are merged in.

## Layout

```
src/main.js            Electron main process: window, PTY spawning, project persistence
src/preload.js         Safe IPC bridge exposed to the renderer as window.api
src/renderer/          UI: index.html, style.css, renderer.js (xterm.js)
```
