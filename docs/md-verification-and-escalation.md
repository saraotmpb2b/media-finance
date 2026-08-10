# MD Verification & Escalation

This covers the step in the Actualisation process that the training deck (*Monthly Actualization & Forecasting*) names but doesn't spell out: **MD Verification** — the secondary check a Media Director runs after the Primary owner has actualised, and before Final Approval locks the month.

Written for anyone stepping into this role cold, with no prior context on the base.

## Where this fits in the process

Per the deck's own "Who is responsible" breakdown:

```
Pre Actualisation Process → PM/COs Actualise → MD Verification → Final Approval
```

| Stage | Owner | What happens |
|---|---|---|
| Pre Actualisation / PM/COs Actualise | Media Planning/Campaign Owners/Performance team member (Primary) | Checks data warnings first, inputs numbers by Campaign and Vendor/Tactic, updates Actualisation status |
| **MD Verification** | **Media Directors (Secondary)** | **← This document.** Cross-check for errors, escalate to the correct owner, verify formulas, approve |
| Final Approval | Media Directors | Check "Actualisation Approval" — this locks the month; data can't be edited after |

Timing: this happens on **Weekday 1**, after Regional Media Ops Teams have filled in Actual Spend (goal: closed by 12pm) and after the Primary owner's own warning check — same day, before the month gets locked via the approval checkbox.

## Step-by-step

1. **Pull every open issue before looking at a single number.** Don't verify formulas first — an error underneath will just resurface after you've already spent time on the math. Check, in this order:
   - **Monthly Actualisation table** → filter `Data Warnings` is not empty
   - **Deliverables table** → filter `Deliverable Warnings` is not empty
   - **Monthly Actualisation table** → any record flagged with >20% Actual-vs-Planned variance (the interface calculates this automatically per the Weekday 1 step)
2. **Triage each one against the table below** — every row tells you whether it blocks approval and who owns fixing it.
3. **Escalate blocking issues immediately** (see "How to escalate" below). Don't wait until you've triaged everything — the person you're escalating to needs runway before the month locks.
4. **Log advisory issues** but don't hold up approval for them — they're real but lower-stakes, and chasing every one before every close would stall the process on things that don't affect this month's numbers.
5. **Once all blocking issues are resolved (or you've gotten an explicit, documented reason to proceed anyway)**, do the secondary numbers/formula check the deck calls for.
6. **Check "Actualisation Approval."** This records who approved and when, and locks the month's data against further edits.

## Escalation matrix

"Blocking" = do not check Actualisation Approval until this is resolved or explicitly signed off with a documented reason. "Advisory" = flag it, but it shouldn't hold up this month's close.

| Issue | Where you'll see it | Blocking? | Escalate to | What they need to do |
|---|---|---|---|---|
| `ERROR: No Deliverable is linked to this record` | Monthly Actualisation → Data Warnings | **Blocking** if the record has Actual Spend; Advisory if it's still Forecast | Campaign Owner / Media Planner for that campaign | Link the correct Deliverable, or explain how the record was created without one (most likely manual entry) |
| `ACTUALISED DELIVERABLE CHANGED` | Deliverables → Deliverable Warnings | **Blocking** | Campaign Owner / Media Planner who owns that Deliverable | Revert the edit on the actualised Deliverable; if the change was intentional, zero its Planned Budget and create a new Deliverable instead |
| `DUPLICATE COMBO` involving Actual Record Type or Actual Spend | Monthly Actualisation → Data Warnings | **Blocking** | Campaign Owner / Media Planner + the Regional Media Ops team member who entered the Actual Spend on either side | Manually reconcile both records' Actual Spend/Client Revenue — never delete either blind |
| `DUPLICATE COMBO` with no Actual data on either side | Monthly Actualisation → Data Warnings | Advisory | Campaign Owner / Media Planner | Merge or delete the stale duplicate before it accumulates more months |
| `CAMPAIGN MISMATCH` involving Actual data | Monthly Actualisation → Data Warnings | **Blocking** | Campaign Owner / Media Planner (usually the one who duplicated the Campaign) | Confirm the correct Campaign and fix the field by hand |
| `CAMPAIGN MISMATCH`, no Actual data | Monthly Actualisation → Data Warnings | Advisory | Campaign Owner / Media Planner | Same fix, lower urgency |
| `No live deliverable could be matched to this record` (Orphan Warning) | Monthly Actualisation → Data Warnings | **Blocking** if it carries Actual Spend on an active campaign; Advisory otherwise | Campaign Owner / Media Planner | Re-link the correct Deliverable, or confirm the row is genuinely obsolete |
| Deliverable-level issue: missing start/end dates, $0/missing budget, missing margin rate | Monthly Actualisation → Data Warnings (attached to a Forecast row) | Advisory (fix before next cycle so it doesn't become a bigger problem) | Campaign Owner / Media Planner | Fill in the missing field on the Deliverable |
| >20% variance between Actual Spend and Planned Budget | Monthly Actualisation interface, flagged per the Weekday 1 step | **Blocking if no reason is documented**; Advisory if a reason is already in the notes/comments | The Regional Media Ops team member who entered the Actual Spend for that record | Document the reason for the variance (vendor delay, mid-flight budget change, etc.), or correct the entry if it was a data-entry error |
| Vendor/Tactic auto-fix (record's own label rewritten to match its Deliverable) | Automation run log only — no warning written to the record | Not blocking, informational only | No escalation needed | Nothing — this is self-healing by design |
| Leftover issue from the **Weekly Budget Categorization / Date Validation** check (still open at month-end) | Weekly "Budget Check" / "Missing Dates" views on Deliverables/Campaigns | Advisory unless it's blocking a current-month Forecast/Actual record, in which case treat it as Blocking via the row above | Media Ops Team Lead (owner of the weekly check) | Complete the weekly check that was missed |
| Leftover issue from the **Monthly Pre-Close Campaign Status & Date Audit** (still open by Weekday 1) | Campaigns/Deliverables tables directly | **Blocking** if it means Script 2 converted the wrong campaigns to Actual this cycle | Regional Ops Leads (owner of that audit) | Correct campaign status/dates; may require manually fixing this month's Actual conversion if it already ran wrong |

## How to escalate

- **Comment directly on the record in Airtable**, tagging the owner (`@` mention) so it lands in their notifications — this keeps the issue attached to the exact row and gives you a timestamped trail for later.
- If it's genuinely urgent (blocking, close to the noon deadline) — message them directly rather than relying on them to check Airtable notifications in time.
- Don't fix Campaign or Deliverable data yourself even if you know the right answer — Campaign/Vendor/Tactic corrections need to come from the owner who understands why the data drifted, otherwise you risk masking the same mistake happening again next month.
- Once an escalated issue is resolved, its warning note won't clear itself — the underlying script only appends new notes and de-duplicates identical ones, it never removes old ones. Manually clear the resolved note from `Data Warnings`/`Deliverable Warnings` once you've confirmed the fix, so next month's leftover notes are only genuinely-still-open ones.
