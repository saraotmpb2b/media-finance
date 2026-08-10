# `generate-forecast-records.js`

**What it is:** an Airtable Script action (`scripts/generate-forecast-records.js`), run from an Automation in this base. It has no CLI entry point — it is copy/pasted into an Airtable Script step, which provides the `base` and `output` globals it depends on.

**What it does:** generates and maintains monthly Forecast rows in the **Monthly Actualisation** table for every active Campaign × Vendor × Tactic combination, spreading each Deliverable's Planned Budget across the months it runs. It also runs several data-integrity passes over the table on every execution — some auto-correct, most just flag a row for a human to look at.

This doc explains what the script touches, what each warning/error means, and how to check whether a run did the right thing. It assumes no prior context.

## Tables and fields touched

| Table | Role |
|---|---|
| **Campaigns** | Read-only. Filters to campaigns not `Cancelled` with an end date in the current month or later ("active"). |
| **Deliverables** | Read-only for most passes. Written to only by the Actualised Deliverable Lock pass (see below) — writes `Actualised Lock Snapshot` and `Deliverable Warnings`. |
| **Vendors** | Read-only. Supplies `Budget Category` per vendor. |
| **Monthly Actualisation** | Main output table. Forecast rows are created/updated here; `Data Warnings` is written by every warning/error pass. |

Fields on **Deliverables** the script depends on existing: `Campaign`, `Platform/Vendor`, `Tactic`, `Planned Start Date`, `Planned End Date`, `Planned Budget`, `Margin Rate`, `Deliverable ID`, `Total Actualised` (rollup of Actual spend against this deliverable), `Actualised Lock Snapshot` (text, internal use only), `Deliverable Warnings` (long text).

Fields on **Monthly Actualisation** it depends on: `Campaign`, `Vendor`, `Tactic`, `Month`, `Record Type` (Forecast/Actual), `Client Revenue`, `Estimated Vendor Cost`, `Forecasted Margin $`, `Margin %`, `Deliverables` (link), `Actual Spend`, `Data Warnings` (long text), `Budget Category`, `Total Tactic/Vendor Budget`, `Previous Months Actual`.

## How it resolves a row's "true" Campaign/Vendor/Tactic

A Monthly Actualisation record stores its own copies of Campaign/Vendor/Tactic, but those can go stale if the linked Deliverable is later re-tagged (a Tactic typo fixed, a Vendor reassigned, a Campaign corrected). The script always tries to resolve the *live* Deliverable's values first via the record's `Deliverables` link, and only falls back to the record's own stored fields if no link resolves. This is why several of the passes below exist — they detect and handle the gap between "what this row says" and "what its linked Deliverable currently says."

## The passes, in order, and what to do about each

Each pass below writes a note into either **Deliverables → Deliverable Warnings** or **Monthly Actualisation → Data Warnings** (never both). Notes accumulate — the field is never fully cleared automatically, only appended to (with de-duplication so the exact same note isn't written twice on repeat runs).

### 1. Actualised Deliverable Lock (writes to `Deliverables → Deliverable Warnings`)

**Why it exists:** once a Deliverable has real Actual spend recorded against it, editing its Campaign, Vendor, Tactic, or Planned Budget silently relabels or reweights *historical, already-booked* Actual records — because everything above resolves through the live Deliverable. That's a much bigger problem than an equivalent edit on a Deliverable with no actuals yet, where it only affects future forecast math.

**What it does:** the first time a Deliverable shows `Total Actualised > 0`, the script freezes a snapshot of its Campaign/Vendor/Tactic/Planned Budget into `Actualised Lock Snapshot`. Every later run compares the live values to that snapshot. A mismatch means someone edited the Deliverable after it already had actuals booked.

**What you'll see:** a note on the Deliverable starting `ACTUALISED DELIVERABLE CHANGED:`, naming exactly which field changed and its old/new values.

**How to resolve:** revert the edit on that Deliverable. If the change was intentional, don't edit the old Deliverable at all — set its Planned Budget to 0 and create a **new** Deliverable to carry the change forward. This pass never blocks or reverts anything itself; it only warns.

**Known gap:** this check is per-Deliverable, not per-combo. If a *different* Deliverable already has actuals against the same Campaign+Vendor+Tactic combination, editing *this* (not-yet-actualised) one won't be caught. It also only compares Campaign/Vendor/Tactic/Budget — not dates, since a date change alone doesn't retroactively affect Actual Spend, Client Revenue, or budget math already booked on Actual rows.

### 2. Forecast generation (creates/updates rows, no warning)

For every active Campaign × Vendor × Tactic combination, spreads Planned Budget across the months the combo's Deliverables run, day-weighted. If a combo already has Actual spend in earlier months, later months' forecast is reweighted proportionally against the *remaining* budget. Existing rows already marked `Record Type = Actual` are never touched here.

Per-Deliverable issues found while doing this (missing dates, $0/missing budget, missing margin rate) go into that row's `Data Warnings` directly as part of this pass, e.g. `Deliverable "X": Missing margin rate`.

### 3. Maintenance pass (updates rows, no warning)

Keeps `Total Tactic/Vendor Budget` and `Previous Months Actual` current on rows the generation pass above wouldn't otherwise touch (mainly existing Actual rows) — these two fields only, nothing else.

### 4. Orphan Warning (writes to `Monthly Actualisation → Data Warnings`)

**Why it exists:** a Forecast or Actual row on a still-**active** campaign whose Campaign/Vendor/Tactic/Month combo can't be resolved to any currently-live Deliverable — usually because the Deliverable it was linked to got deleted or reassigned. These rows sit outside the maintenance pass, so their budget/actuals figures can silently go stale.

**What you'll see:** `No live deliverable could be matched to this record (it may have been deleted or reassigned) - Total Tactic/Vendor Budget and Previous Months Actual may be stale. Please review.`

**How to resolve:** find/re-link the correct Deliverable, or confirm the row is genuinely obsolete.

### 5. Duplicate Combo Warning (writes to `Monthly Actualisation → Data Warnings`)

**Why it exists:** two different rows can end up resolving to the exact same Campaign/Vendor/Tactic/Month key — typically because a Deliverable's Vendor or Tactic was edited to match a combo that already had its own row.

**What you'll see:** `DUPLICATE COMBO: record <id> resolves to the same Campaign/Vendor/Tactic/Month combo as this one...` — one side is marked "kept" (still being maintained going forward), the other "dropped" (frozen/stale). If either side has Actual Record Type or Actual Spend, the note explicitly says **DO NOT DELETE** either record.

**How to resolve:** manually review both rows and merge/reconcile them into one. Never delete blind — if real spend is on either side, deleting could destroy financial history.

### 6. Vendor/Tactic Auto-Fix (updates rows, no warning — this one self-heals)

**Why it exists:** if a Deliverable's Tactic or Vendor gets corrected (a typo, a trailing space, a duplicate select option), rows already created under the old label would otherwise sit permanently split from the corrected group in any view/report grouped on this table's own Tactic/Vendor field.

**What it does:** rewrites the row's own `Vendor`/`Tactic` field to match its linked Deliverable's current value. This is the *only* self-correcting pass in the script — safe because it only ever touches a label, never `Actual Spend`, `Client Revenue`, or `Record Type`.

**What you'll see:** nothing on the record itself; the fix is logged to the Automation run's console output (`Auto-fixing Tactic on <id>: "old" -> "new"`).

### 7. Campaign Mismatch Warning (writes to `Monthly Actualisation → Data Warnings`)

**Why it exists:** a row's own `Campaign` field can disagree with what its linked Deliverable resolves to — most often from duplicating a Campaign (which copies this table's Campaign link onto the duplicate without moving the Deliverables link). Unlike Vendor/Tactic, this is **never** auto-corrected: re-linking automatically risks silently moving real financial data under the wrong Campaign.

**What you'll see:** `CAMPAIGN MISMATCH: Campaign says "X" but its linked Deliverable(s) say "Y". ...` If the row has Actual data, it adds **DO NOT DELETE**.

**How to resolve:** a human confirms which Campaign is correct and fixes the `Campaign` field by hand.

### 8. Missing Deliverable Link Error (writes to `Monthly Actualisation → Data Warnings`)

**Why it exists:** any row — Forecast or Actual, active campaign or not — with a completely empty `Deliverables` link. This is a stricter, unconditional check than Orphan Warning above (pass 4), which only looks at still-active campaigns and only catches combos that fail to *resolve* (not necessarily a truly empty link field). Money that can't be traced to any Deliverable at all is a data-integrity error independent of whether the campaign is still running.

**What you'll see:** `ERROR: No Deliverable is linked to this record. Its Actual Spend/Client Revenue cannot be traced to any Deliverable - please link one or investigate how this record was created.`

**How to resolve:** link the correct Deliverable, or investigate how the row was created without one (manual entry is the most likely cause, since every row this script creates always gets a Deliverables link).

## How to check whether a run went well

1. **Automation → Run history → open the latest run.** The script logs each pass's queued count as it goes (e.g. `Duplicate combos detected: 2`, `Missing-deliverable-link errors queued: 3`), ending in one summary line:
   `✅ Forecast Complete! Created: X, Updated: X, Maintained: X, Flagged: X, Duplicates Flagged: X, Vendor/Tactic Fixed: X, Campaign Mismatches Flagged: X, Deliverable Lock Updates: X, Missing Deliverable Link Errors: X`
   Sanity-check the counts against what you expected to change.
2. **Monthly Actualisation → filter `Data Warnings` is not empty.** This surfaces every flagged row from passes 4, 5, 7, and 8 above. Each note names the problem and the fix in plain language.
3. **Deliverables → filter `Deliverable Warnings` is not empty.** Surfaces pass 1 (actualised-deliverable-edited-after-the-fact).
4. **Deliverables → `Actualised Lock Snapshot`.** Spot-check a couple of Deliverables with `Total Actualised > 0` — this field should be non-blank. It's an internal fingerprint, not meant to be human-readable.
5. **Spot-check one Forecast row** for a Campaign/Vendor/Tactic combo you know well: confirm `Client Revenue`, `Total Tactic/Vendor Budget`, and `Previous Months Actual` look right for the current month.

## Change log

| Commit | Change | Why |
|---|---|---|
| `1d4196c` | Added `generate-campaign-monthly-performance.js` (separate script, see below) | Roll up Actuals into a Campaign-level monthly report table. |
| `543758e` | Rewrote that script without template literals | Some copy/paste paths into Airtable's script editor mangle backtick strings into a syntax error; plain string concatenation survives regardless of source app. |
| `93c4eab` | Added Duplicate Combo detection | Deliverable relabeling could make two live rows collide on the same combo key with no warning either side. |
| `85ddabf` | Rewrote the Forecast→Actual cutover script (separate script, see below) | — |
| `cd849b1` | Extended duplicate-combo flagging to Actual-data collisions, with explicit no-delete guidance | A collision involving real spend needs manual reconciliation, not a suggestion to delete. |
| `e78f046` | Added Campaign/Vendor/Tactic mismatch detection between a row's own fields and its linked Deliverable | Rows were going stale silently when a linked Deliverable's labels changed after the row existed. |
| `2fefd83` | Made Vendor/Tactic mismatches self-heal automatically; kept Campaign mismatches warn-only | Vendor/Tactic is a safe label-only fix; Campaign changes risk moving real financial data and need a human. |
| `bdcf34a` | Added the Actualised Deliverable Lock pass | Editing a Deliverable after it already has real Actual spend booked was previously invisible — it would silently relabel/reweight historical financial rows. |
| `6ded1ea` | Added the Missing Deliverable Link error pass | The existing Orphan Warning only covered active campaigns and unresolved combos; a plain empty-link check across *all* rows, active or not, closes that gap. |

## Other scripts in this repo (context, not covered in detail above)

- **`scripts/generate-campaign-monthly-performance.js`** — rolls up Client Revenue and Actual Spend from Monthly Actualisation's Actual rows into one row per Campaign × Month, for a separate "Campaign Monthly Performance" reporting table. Read-only against Monthly Actualisation.
- **`scripts/monthly-actualisation-cutover.js`** — runs on the 28th of each month; converts that month's Forecast rows to Actual, and reconciles `Total Tactic/Vendor Budget`/`Previous Months Actual` on every existing Actual row. Uses the same live-Deliverable resolution strategy as this script, for the same reason.
- **`scripts/calculate-actual-tactic-cost.js`** ("Script 3") — for the month currently being actualised, backfills `Actual Tactic Cost` from `Actual Spend` using a margin rate keyed by Budget Category, wherever it hasn't already been set. Runs after Actual Spend entry (Weekday 1) and before MD Verification — see `docs/md-verification-and-escalation.md` for when to trigger it and how its warnings get escalated.
