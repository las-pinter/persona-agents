---
name: journal-management
description: Orchestrator journal root and the orchestrator startup report.
---

# Journal Management (Orchestrator)

Load **journal-management-generic** first. It owns the journal procedure: the
folder layout, reading, the write script, the `append` and `replace` write
model, the entry structure, the 100-line limit, and the consolidation rules.
Do not restate it here.

## Orchestrator Additions

- **Journal root:** `<AGENT_TYPE>` is `orchestrator` for this profession.
  Journals live in `<USER_HOME>/agent-notes/orchestrator/`.

`<USER_HOME>` is the folder that holds `agent-notes`. Follow the
**journal-management-generic** skill for the exact rule and the fallback.

- **Write script:** Call `journal-write.sh` from the
  **journal-management-generic** skill folder. It does not live in this
  skill's `scripts/` folder, which holds only the startup report.

- **Startup report:** The agent runs this skill folder's
  `scripts/startup-report.sh` with bash at the start of every session.
  Pass the full path, unquoted, so the gate can match it.
  The report prints the facts, then the text of the note rules, the summary,
  and the recent journals.
  Use the no-dump flag only when you already read those files in this session.
  Every breach line names the measured fact, its value, and its limit.
  Record each breach per the startup guard in the **project-notes** skill.
  The report names the oldest unconsolidated week; consolidate it per the
  **journal-management-generic** schedule.
  The **project-notes** skill owns the note limits; a limit change changes the
  numbers inside the report script too.
  Skip the report in a headless run when the platform asks for a prompt.
  State in the output that the report is blocked.
