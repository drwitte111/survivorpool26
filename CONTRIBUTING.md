# Working on this with two people

Two of us push to this repo and it auto-deploys to Netlify. This is how to avoid
standing on each other.

## The one habit that matters

**Always pull with rebase before you push.**

```bash
git pull --rebase
```

Set it as the default once, on each machine, and then forget about it:

```bash
git config --global pull.rebase true
```

Almost every "merge error" is really this: someone else pushed while you were
working, so your push is rejected because it isn't a fast-forward. `pull --rebase`
replays your commits on top of theirs and the push goes through. Without
`--rebase` you get a merge commit every time and the history turns to soup.

## Can one of us overwrite the other?

Not by accident. Git refuses a push that would drop someone else's commits — that
rejection *is* the safety net, not a bug. The only way to actually destroy
someone's work is `git push --force`, which is why the setup below blocks it.

**Never run `git push --force` on `main`.** If you think you need it, you want
`git pull --rebase` instead. On your own branch, use `--force-with-lease`, which
refuses if someone else has pushed in the meantime.

## Day-to-day flow

For anything more than a one-line fix, work on a branch:

```bash
git checkout -b spreads-tweak
# ... edit ...
git add -A && git commit -m "Tighten the spread editor layout"
git push -u origin spreads-tweak
```

Open a pull request. Netlify builds a **Deploy Preview** at its own URL, so you
can look at the change running for real before it touches the live site. Merge
when it looks right.

Small, frequent commits conflict far less than one big one. If you're about to
touch something large, say so first — that costs a message and saves an hour.

## If you do hit a conflict

```bash
git pull --rebase
# Git lists the conflicted files.
# Open each one, pick the right content, delete the <<<<<<< ======= >>>>>>> markers.
git add <file>
git rebase --continue
```

To bail out and start over: `git rebase --abort`.

`node tools/check.mjs` catches a half-finished merge — it fails on leftover
conflict markers, imports pointing at things that no longer exist, and broken
data files. Run it before you push. CI runs it too.

## Things that used to conflict and no longer do

- **`sw.js` version.** This used to be a hand-edited `const VERSION = 'v6'`, so
  both of us bumped the same line every week and collided every time. It's now
  stamped from the commit SHA at deploy time by `tools/stamp-build.mjs`. Leave
  `__BUILD_ID__` alone.
- **Line endings.** `.gitattributes` normalises everything to LF in the repo. Without
  it, one Windows machine and one Mac can produce diffs where every line looks
  changed, turning a one-line edit into a whole-file conflict.

## Still likely to conflict

Some files are just busy. If we're both in one of these, a quick heads-up beats
untangling it afterwards:

| File | Why |
|---|---|
| `js/ui/week.js` | The biggest UI module; most features touch it |
| `data/config.json` | Small file, so edits land close together |
| `README.md` | Everybody appends to the end |
| `data/schedule.csv` | Fine for scattered rows, painful if we both re-sort it |

## Before you push

```bash
node tools/check.mjs
```

Then serve it and click through the change:

```bash
npx http-server . -p 8181 -c-1
```
