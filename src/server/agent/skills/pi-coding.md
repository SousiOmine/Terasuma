# Writing code with pi-coding-agent

pi is a coding agent CLI installed in the computer: the Debian container where read,
write, edit and bash run. tmux, bun, node and git are available there too. When the user
asks for code to be written, fixed or refactored, let pi do the editing instead of editing
the files yourself. Its work files and tmux session are per job, so several jobs can run at once.

## When to use it

- The user asks you to write, implement, fix, refactor or restructure code.
- You are about to change files in a repository.

Do not call write or edit yourself for this work. Load this skill, send the job to pi, and
check what pi produced.

## Call pi through tmux

Give each job its own slot (`docs`, `tests`, ...): its own files and tmux session, so
several jobs can run at once. Run this in your workspace folder.

```sh
slot=docs
work="$HOME/.pi-work/${PWD##*/}/$slot"; session="pi-work-${PWD##*/}-$slot"
mkdir -p "$work"

cat > "$work/prompt.md" <<'BRIEF'
<job for pi: files, expected behavior, what not to touch, tests, and "do not commit, push,
delete anything, or send anything outside this computer">
BRIEF

tmux kill-session -t "=$session" 2>/dev/null
tmux new-session -d -s "$session" -c "$PWD" -x 220 -y 60
tmux send-keys -t "$session" -l "pi -p \"$(cat $work/prompt.md)\" 2>&1 | tee -a $work/log; echo __PI_DONE__ >> $work/log"
tmux send-keys -t "$session" Enter
```

- Put the job in a file: a long request inside the tmux command line is silently dropped.
- `-t "=$session"` is an exact match; a prefix would also hit `job1` from `job10`.
- `tmux ls` shows the running jobs.

## While a job runs

Starting a job returns at once; tmux keeps it running in the background. Keep working:
ask the user, start another job in its own slot, or read something else. Check a slot when
you need its result.

```sh
slot=docs; work="$HOME/.pi-work/${PWD##*/}/$slot"
grep -qx __PI_DONE__ "$work/log" && grep -v '^__PI_DONE__$' "$work/log" | tail -60 || echo "still running"
```

- No marker: still running. `tmux capture-pane -p -t "pi-work-<tera id>-$slot" -S -60` shows where it is.
- Only the marker line `echo` wrote means it is over; your own command line contains the word too.
- Stop one job with `tmux kill-session -t "=pi-work-<tera id>-$slot"`.
- A bash call is cut off at about 10 minutes; wait in a loop only when you have nothing else to do.

## Running jobs side by side

Start each job in its own slot and wait for the ones you started; keep it to a handful.

- Two jobs that change the same files overwrite each other. Split the files, or give a job
  its own worktree: `git worktree add -b "pi/$slot" "$work/tree" HEAD`, start pi with
  `-c "$work/tree"`, read `git -C "$work/tree" diff`, then `git worktree remove "$work/tree"`.
- Do not run git commands that change state (`checkout`, `stash`, `rebase`, ...) while a job runs.

## What to put in the request

Files and directories to change, the behavior you expect and how to check it, what must not
be touched, and whether tests are needed. Always add: "Do not commit, push, delete anything,
or send anything outside this computer." Keep one job to one concern; split a large job.

## Check the result yourself

- Read `git status --short` and `git diff` before accepting the work.
- Run `bun run typecheck`, `bun run lint` and `bun test` (or the repository's
  equivalents) and read the failures.
- Do not trust pi's "I checked it" message. The files and the command output are the
  evidence.

## When something is wrong

Send the work back to pi with a specific description of what is wrong in the diff. Fix it
yourself only when the change is obviously one or two lines, or after pi has failed twice
in a row. If you do edit it yourself, say so in your reply to the user.

## Rules

- Several jobs at once are fine, one slot each. Two jobs in one slot overwrite each other's
  prompt and log and kill each other's session.
- For a short question that needs no repository changes (a one-line check), calling
  `pi -p 'question'` once directly is fine.
- If pi is not connected or not available, ask the user to connect it in Settings >
  Connectors. The agent can also load the connectors skill and call app_connect_pi.
