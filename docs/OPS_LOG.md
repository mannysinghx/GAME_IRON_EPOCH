# OPS LOG — IRON EPOCH

One line per action with a side effect outside the working tree.
Format: timestamp · what · why · how to undo · verified?

- 2026-10-18T23:03:22Z · npm install of pinned deps in apps/web (vite 7.3.7, typescript 5.9.3, preact 10.29.8, pixi.js 8.22.0, @fontsource fonts 5.3.0) · build toolchain for the browser sandbox · rm -rf apps/web/node_modules · yes (30 packages, 0 errors)
- 2026-10-18T23:03:22Z · started Vite dev server on 127.0.0.1:5317 (new port, no existing service touched) · preview and verify the game in the browser · stop it from the preview pane or kill the vite process on :5317 · yes (page loads, 0 console errors, all requests to localhost)
- 2026-10-18T23:16:59Z · browser IndexedDB 'iron-epoch' (localhost:5317) now holds a world snapshot; SAVE_VERSION bumped 3→5 during tuning so stale snapshots are discarded · persistence of the sandbox world · Engine tab → New world, or clear site data for localhost:5317 · yes (bet escrow survived reload)
- 2026-10-18T23:16:59Z · git init in project root + first local commit (no remote, nothing pushed) · user rule: commit after build and test · rm -rf .git · yes
