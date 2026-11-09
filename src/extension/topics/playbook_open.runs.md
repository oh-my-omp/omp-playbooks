---
title: Runs
when: before running the same Playbook again from a clean state, or passing run
---
# Runs

To run the same Playbook again from a clean state, `xd://playbook_run {op: "start", name: "<run name>"}` copies it into a Run (`r<n>`) with every status back to `todo` and no reports. Starting a Run starts no agent.

Pass `run: "r1"` to the same tool calls and `playbook.*` helpers to work in that Run; leave it out to work in the Playbook itself. `xd://playbook_run {op: "finish", run: "r1"}` ends the Run: its Launches close, its blocks can no longer be edited through tools, and a retrospective may be posted to its timeline.

`doc` may be omitted while exactly one Playbook is open.
