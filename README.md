# Local Developer Dashboard

Windows-first local web app for tracking Git repositories on one computer.

The dashboard is **read-only** toward tracked repositories. It never runs `git fetch`, `git pull`, `git push`, `git add`, `git commit`, checkout, reset, stash, or similar mutating commands.

## Requirements

- Node.js 24.19+
- system Git
- optional: GitHub CLI (`gh`) for GitHub metadata

## Start

```bat
npm install
npm run dev
```

Then open:

- UI: http://127.0.0.1:5173
- Health: http://127.0.0.1:8787/api/health

The API binds only to `127.0.0.1`. SQLite is created automatically at `data/dashboard.sqlite`.

### Production

```bat
npm run build
npm start
```

Then open http://127.0.0.1:8787

## Checks

```bat
npm run typecheck
npm test
npm run build
```

## Disposable test repository

Do not use an important project as the first fixture. Create a throwaway repo:

```bat
mkdir C:\temp\dashboard-fixture
cd C:\temp\dashboard-fixture
git init -b main
git config user.email "dev@example.com"
git config user.name "Dev"
echo hello> README.md
git add README.md
git commit -m "initial"
```

Add that folder as an individual repository in **Sources**, then change it *outside* the dashboard:

1. Clean — should show `Clean`
2. Edit `README.md` — should show `Uncommitted` and a modified file
3. Create `loose.txt` — untracked count increases
4. `git add loose.txt` — staged count increases
5. `git commit -m "fixture change"` — new commit appears; working tree returns to `Clean`
6. `git checkout -b feature` — branch updates after Rescan

The dashboard must observe these states without modifying the fixture.

`fixtures/disposable-repo/` is gitignored if you keep a local copy inside this project.
