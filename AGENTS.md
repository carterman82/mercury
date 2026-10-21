# Subagent delegation

Use the available multi-agent tools proactively for isolated, independently
verifiable work. The main agent owns task decomposition, user communication,
integration, final verification, and the final response.

## Mandatory delegation cases

Spawn one or more read-only subagents before beginning substantive analysis when
the request includes any of the following:

- four or more uploaded files;
- a mix of documents, images, PDFs, spreadsheets, CSVs, logs, or similarly
  independent source files;
- a large collection of source material requiring extraction, comparison,
  classification, or synthesis;
- two or more independent research, codebase-exploration, test, or review
  tasks.

Split the work by file groups or clear analytical dimensions, and run
independent read-heavy subtasks in parallel when agent capacity permits. Give
each subagent a self-contained objective, relevant constraints, and an expected
deliverable. Do not parallelize edits to the same files or work requiring a
single, tightly shared line of reasoning.

Use configured default subagents unless a specialized agent is clearly a better
fit. Do not spend significant time reading or synthesizing the full source set
in the main agent before delegating; only inspect enough to create useful
assignments.

When subagents are used, state in a concise progress update that delegation is
underway, name the assigned work at a high level, and state the number of
subagents. In the final response, include a brief note that subagents were used
and summarize their contributions. If none were used, do not add a note.
