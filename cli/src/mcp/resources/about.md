# About Aside

## Durable files, derived views

- Markdown and YAML are authoritative. Records remain readable without a database; Git carries committed history.
- Structured metadata supports software views. Free-form bodies preserve context beyond those fields.
- Custom files and metadata can extend an instance; core tools preserve information they do not understand.

## One shared runtime

One local daemon coordinates record writes, watches external file changes, and
runs Calendar synchronization and automations. Agents and browser views share
the same derived record model.

Calendar is a synchronized surface: supported individual edits flow back, while
Aside owns recurrence definitions.

## Commitments and execution

A recurring action defines a repeating commitment; automation schedules script
or agent execution.

- Occurrences remain projections until edited, avoiding an indefinitely growing collection of saved future records. An edited occurrence retains its own content and original identity.
- Automation can create or update work, but a successful process exit does not establish that a commitment was fulfilled. Runtime history stays separate from the productivity record.

## Instance boundaries

- An instance separates history, instructions, and files. Splitting instances provides lasting separation but fragments context.
- Instance instructions shape agent behavior only within that instance. They are user-authored content, not configuration parsed by the software.
