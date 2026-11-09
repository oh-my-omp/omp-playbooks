---
title: Model judgment report
when: before op report
---
# Judge report

1. `inspect` returns the blocks' deterministic findings, the judge questions and a `version`.
2. Answer each question with `judge` in eval, as the probability that the answer is yes.
3. `report` with the same blocks and the `version` from step 1: `result: "answers"` with one `answers` entry per question (each `probability` in 0–1; `P(yes) >= 0.5` counts as failed), or `result: "judge_unavailable"` when no judge is available, which counts as not judged, not as passed.

A report whose `version` is no longer the latest for that document, Run and block list is ignored. Checks never gate a launch, except a compile failure.
