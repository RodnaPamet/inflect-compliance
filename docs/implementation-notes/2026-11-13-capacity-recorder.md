# 2026-11-13 — The capacity recorder (capacity budget C1b)

**Commit:** see the pull request `feat(deploy): a capacity recorder on the VM for C1b's nightly peaks`

## Design

C1b (docs/implementation-notes/2026-11-12-capacity-c1.md, "Follow-up") needs
`app`'s and `worker`'s memory peaks across the 02:00–05:30 UTC nightly chain
and the 00:15–01:45 UTC parser window. The snapshot could not give them, for
two reasons: Watchtower recreates both containers on every merge to main, which
resets the cgroup's `memory.peak`, and `VM capacity` samples only when the
owner approves a run, which is never at night. Owner decision 2026-11-13: a
recorder on the host.

```
inflect-capacity-record.timer   every 10 min on the clock (:00, :10, …)
        │
        ▼
inflect-capacity-record.service  oneshot, root, Nice 10, idle I/O, 20% CPU, 64M
        │  /bin/bash /usr/local/lib/inflect-capacity/inflect-capacity-record.sh
        │  docker ps (id, name) + one docker inspect (id, StartedAt)
        │  cgroup v2: memory.current, memory.peak, memory.stat anon/file, cpu.stat usage_usec
        ▼
/var/lib/inflect-capacity/capacity-YYYY-MM-DD.tsv   (0700 dir, 0600 files, 9 days, capped)
        │
        ▼
VM capacity, mode=history, hours=N  →  deploy/capacity/vm.sh  →  history.sh on the VM
        coverage + gaps · per-container window peaks · parser/nightly windows per day
```

The rows are the snapshot's own source (`deploy/capacity/remote.sh` reads the
same five cgroup files from the same two candidate paths), so a history figure
means what a snapshot figure means.

**Installed through the existing host config set.** `apply.sh`'s
`HOST_CONFIG_SET` held one file with ops-agent-specific validate and reload
steps inline, and its header said a second member was the moment to
generalise. It now holds four, and each file's owner is decided by its remote
path (`host_config_owner`): the ops agent keeps exactly its old validation
(engine), activation (restart) and verification (compiled config); the
recorder is validated with `bash -n`, `systemd-analyze verify` and one trial
pass of the staged script against the host's real cgroups into a throwaway
directory, and activated with `daemon-reload`, `enable --now` the timer, one
pass, and a check for a row. The `VM apply` actions `host-config-preflight` /
`host-config-apply` are the way in; `check-drift.sh`'s `APPLIABLE` watches the
three files, and `deploy-canonical-set-is-watched` holds the agreement.

**Removed through a named action.** `retire-capacity-recorder` in
`deploy/vm-apply/remote.sh` stops and disables the timer and removes the units,
the script and the rows. The host config path has no delete, so removal is the
same shape as the OrangeHRM lab's container retirement: a fixed action, then a
revert of the entries.

## Files

| File | Role |
| --- | --- |
| `deploy/capacity/recorder/inflect-capacity-record.sh` | one pass: retention, caps, two docker calls, one row per container |
| `deploy/capacity/recorder/inflect-capacity-record.service` | the oneshot unit, bounded and hardened |
| `deploy/capacity/recorder/inflect-capacity-record.timer` | every 10 minutes on the clock |
| `deploy/capacity/history.sh` | the read: coverage, window peaks, parser and nightly windows |
| `deploy/capacity/vm.sh` | `snapshot` or `history` mode |
| `.github/workflows/vm-capacity.yml` | `mode` (choice) and `hours` inputs |
| `deploy/apply.sh` | host config set generalised to owners; recorder preflight and activation |
| `deploy/check-drift.sh` | watches the three files |
| `deploy/vm-apply/vm.sh`, `remote.sh`, `.github/workflows/vm-apply.yml` | `retire-capacity-recorder` |
| `tests/guards/capacity-recorder.test.ts` | runs the recorder, the reader and apply.sh's preflight against fixtures |
| `tests/guards/vm-capacity-workflow.test.ts`, `vm-apply-workflow.test.ts` | the new inputs, scripts and action |
| `docs/deployment.md` | "The capacity recorder", and the two workflow tables |

## Decisions

- **The script is pushed 0644 and run through `/bin/bash`.** Every host config
  file is pushed 0644 by one line; the unit names the interpreter, so no
  per-file mode had to enter the `local:remote` entry format, which two
  scripts and a guard parse.
- **Retention by the date in the name, not by mtime.** Today plus the eight
  days before it, so the longest read (192 hours) always finds the nine day
  files it spans.
- **Hard caps refuse the write rather than trim.** 4 MiB per day file, 40 MiB
  for the directory, 1 GiB free on the filesystem. A refused pass shows as a
  gap in the history's coverage, which is visible; a recorder that deleted
  rows to make room would make an old night silently vanish.
- **The timer is on the clock.** Passes land at :00, :10, …, so the parser
  window holds 9 passes (00:20–01:40) and the nightly window 22 (02:00–05:30)
  every day; the reader buckets each row to its 10-minute mark, so a pass a few
  seconds late still belongs to its window and the pass an apply runs is not
  counted twice.
- **"Rose in window" rather than a computed per-window peak.** `memory.peak`
  is the high-water mark since the container started. The reader compares the
  first and last `memory.peak` inside each window: if it rose, the window's
  max `memory.peak` is that window's own peak; if not, the 10-minute
  `memory.current` samples are the best figure; a restart inside the window is
  reported as such.
- **The preflight's trial pass is the real gate.** `systemd-analyze verify`
  proves the units load; only running the script on the host proves it finds
  the containers' cgroups, and a recorder that cannot would write nothing every
  ten minutes and report nothing wrong. It must write at least one row.
- **Every owner is activated on every host-config apply.** Restarting the ops
  agent when only the recorder changed costs a few seconds of log shipping;
  activating only changed owners would need the preflight's hashes carried into
  the apply, for little gain. Both activations are idempotent.
- **Retiring deletes the rows.** The rollback is "leave nothing behind"; read
  the history first if the rows are wanted.
