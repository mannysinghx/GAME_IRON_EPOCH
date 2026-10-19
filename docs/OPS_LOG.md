# OPS LOG — IRON EPOCH

One line per action with a side effect outside the working tree.
Format: timestamp · what · why · how to undo · verified?

- 2026-10-18T23:03:22Z · npm install of pinned deps in apps/web (vite 7.3.7, typescript 5.9.3, preact 10.29.8, pixi.js 8.22.0, @fontsource fonts 5.3.0) · build toolchain for the browser sandbox · rm -rf apps/web/node_modules · yes (30 packages, 0 errors)
- 2026-10-18T23:03:22Z · started Vite dev server on 127.0.0.1:5317 (new port, no existing service touched) · preview and verify the game in the browser · stop it from the preview pane or kill the vite process on :5317 · yes (page loads, 0 console errors, all requests to localhost)
- 2026-10-18T23:16:59Z · browser IndexedDB 'iron-epoch' (localhost:5317) now holds a world snapshot; SAVE_VERSION bumped 3→5 during tuning so stale snapshots are discarded · persistence of the sandbox world · Engine tab → New world, or clear site data for localhost:5317 · yes (bet escrow survived reload)
- 2026-10-18T23:16:59Z · git init in project root + first local commit (no remote, nothing pushed) · user rule: commit after build and test · rm -rf .git · yes
- 2026-10-19T01:22:02Z · npm: added three@0.180.0 and @types/three@0.180.0 (pinned), removed pixi.js after the 2D renderer was replaced · 3D battlefield · npm uninstall three @types/three && npm install pixi.js@8.22.0 (or git checkout c053365 -- apps/web/package*.json && npm install) · yes (tsc 0 errors, vite build ok)
- 2026-10-19T01:22:02Z · SAVE_VERSION 5→6 and save format change (base64 arrays): existing browser snapshots start a fresh 128×128 world · new theatre size · none needed (old worlds are not migrated) · yes (fresh load, no console errors)
- 2026-10-19T01:45:33Z · AI rebalance committed (DEFEND trigger and deconfliction, opportunity term, smaller reserves, plunder and half occupation income, advantage-trained faction-shared learner); no SAVE_VERSION bump, existing worlds keep running with the new rules · break the defensive stalemate and make learning measurable · git revert the rebalance commit · yes (selftest pass; census and paired-fork evaluations in scratchpad/rebalance)
- 2026-10-19T02:24:14Z · restarted the Vite dev server on 127.0.0.1:5317 (it had been stopped by the app; same port, nothing else touched) · verify the rating reset on the saved browser world · stop it from the preview pane · yes (page loads, 0 console errors)
- 2026-10-19T02:24:14Z · fairness fix: on load, snapshots without fairRatings reset every commander's Elo/eval record and the duel log (chronicle 'eval' entry); world otherwise intact · old ratings were biased by commander-id timing · not reversible from the snapshot (the old ratings were invalid) · yes (reset entry seen at 03:44:17, world resumed)
