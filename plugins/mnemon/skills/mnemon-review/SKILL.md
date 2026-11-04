---
name: mnemon-review
description: >-
  Review what Mnemon captured and reconcile what conflicts. Use after a working session, when candidates are
  waiting, when the user asks what was remembered, or when memory may contain duplicates or contradictions.
---

# Review captured memory

## 1. Look at the queue

`mnemon_memory_candidate_list` returns the facts captured automatically (only when active capture is on) or queued by hand. Each has a reason and the session it came from.

## 2. Judge each candidate

- **Adopt** when the fact is durable and true: `mnemon_memory_candidate_resolve` with `action: "adopt"` and the space it belongs to. Reword it first if it is not a clean single sentence, and pass `text` with the reworded version.
- **Reject** when it is transient, already covered, or was never agreed: `action: "reject"`.
- **Ask** when the candidate is ambiguous. Never adopt something the user did not actually state.

Batch the decision: present the queue as a short numbered list with your recommendation, then apply the user's answers in one pass.

## 3. Reconcile what is already stored

`mnemon_memory_audit` returns four buckets:

| Bucket | What it means | What to propose |
| --- | --- | --- |
| `duplicates` | Two memories say the same thing | Merge into the better wording with `mnemon_memory_update`, then `mnemon_memory_forget` the other |
| `conflicts` | Same subject, different numbers, or one side negated | Ask the user which is current; update the survivor, retire the other |
| `stale` | Old and never recalled | Confirm before retiring; a rarely used fact may still be the record |
| `emptySpaces` | A space with no memories | Either use it or drop it from the plan |

Present one reconciliation plan — the pairs, the proposed survivor, the proposed retired wording — and apply it only after the user accepts. Then re-run `mnemon_memory_audit` and show that the bucket is empty.

## 4. Close with the state

Report counts (`mnemon_memory_status`), what was adopted, what was retired, and anything you left untouched on purpose.
