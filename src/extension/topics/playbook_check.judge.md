---
title: Model judgment report
when: before op report
---
# Judge report

1. `inspect {blocks}` returns the blocks' deterministic findings, the judge questions and a `version`.
2. Answer each question with `judge` in eval, as the probability that the answer is yes.
3. `report {blocks, version, result}` with the same blocks and the `version` from step 1:
   - `{kind: "answers", answers: {<question id>: P(yes)}}`, each value in 0–1; `P(yes) >= 0.5` counts as failed;
   - `{kind: "judge_unavailable"}` when no judge is available; it counts as not judged, not as passed.

A report whose `version` is no longer the latest for that document, Run and block list is ignored. Checks never gate a launch, except a compile failure.
