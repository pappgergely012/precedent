# Weekly log for a design-partner trial (DRAFT)

A template for the five-minute weekly log. The columns follow the validator's draft in the internal repo
(`ops/validation/design-partner-success-criteria.md`); if that draft changes, change this file to match. All thresholds
and definitions live there and are assumptions until a pilot has run.

Copy `success-log-template.csv` and add one row per rule per week.

| Column | Meaning |
|---|---|
| `date` | the Monday of the week, `YYYY-MM-DD` |
| `rule_id` | the id from `precedent approve` (for example `a-1b2c3d4e5f`) |
| `tier` | `core` or `emerging`, as `mine` printed it |
| `decision` | at review time: `approve`, `edit`, `reject` or `defer` |
| `reason_code` | for a rejection: `generic`, `one-off`, `stale`, `wrong`, `duplicate`, `conflicts`, `single-reviewer` |
| `outcome` | blank until the end of the trial: `useful`, `neutral`, `wrong`, `generic` or `ignored` |
| `evidence_link` | link to a review comment or change that shows the rule being used |
| `applied_count_this_week` | how often the rule was applied in review or by an agent |
| `flagged_wrongly_this_week` | how often it was applied where it did not belong |
| `exported` | `y` or `n`: is the rule in the exported agent file |
| `followed_by_agent` | `y`, `n` or `na` |
| `minutes_spent_this_week` | time spent on this rule |
| `free_text` | anything else |

Use `precedent approve --note TEXT` to keep a short reason next to the rules you approve; it is shown by `approve` and
`compare` and is never exported or sent to a model.
