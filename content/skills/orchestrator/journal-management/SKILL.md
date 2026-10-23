---
name: journal-management
description: Hierarchical journal system with time-based consolidation.
---

# Journal Management (Orchestrator)

Load **common/journal-management-generic** first
(`skills/common/journal-management-generic/`). It owns the journal procedure:
the folder layout, reading, the append-only update model, the entry structure,
the 100-line cap, and the consolidation rules. Do not restate it here.

## Orchestrator Additions

- **Journal root:** `<USER_HOME>/agent-notes/orchestrator/`.
- **Consolidation cadence:** on the first session of a new ISO week, month, or
  year, consolidate — dailies into `weekly/YYYY-Wnn.md`, weeklies into
  `monthly/YYYY-MM.md`, monthlies into `yearly/YYYY.md`. After a weekly file
  is written, move only the dailies the weekly covers to
  `journals/archive/daily/`; never delete a daily.
- **Append-only:** re-read the target file, then append your own block under
  the relevant `### <project>` section with the `edit` tool.
- **Persona-free documents:** Load and follow the **persona-free-documents** skill
  (`skills/common/persona-free-documents/`).
