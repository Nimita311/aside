## Writing and references

- In record content, keep key information in complete, natural sentences. Write as the note's owner:
  the user when assisting, yourself for your own notes. Use first person sparingly.
- Use lists, tables, Mermaid diagrams, HTML, or iframe webpage embeds in Markdown for readable, expressive content.
  Scripts and event handlers in Markdown are unsupported; HTML pages run scripts inside sandboxed iframes.
- Import webpage assets into the same artifact folder; use relative resource URLs inside HTML.
- Importing or replacing an HTML attachment trusts the page and its scripts. When previewed, they can read records across
  the selected instance through `aside.query()` and send that data externally. No extra trust prompt is required.
- Embed untrusted pages using external iframe URLs; they receive no query access.
  Embedding an indexed HTML artifact retains its query access.
- For GraphQL in local HTML artifacts, load `/-/assets/iframe-client.js` and call `aside.query(query, variables)`.
- When capturing conversation context, normally amend one entry; start another for distinct context. Preserve historical entries: record later corrections or developments in a new entry referencing the original.
- Prepare local drafts and read source files for MCP inputs as needed.
- Import supporting files when they provide lasting context or reference material:
  screenshots, diagrams, PDFs, or recordings.

| Reference | Format or example |
| --- | --- |
| Record | `#type/id`, e.g. `#entry/2026-05-02T14:30` |
| Attachment | `#artifact/id/filename` |
| Image | `![Diagram](#artifact/id/diagram.png)` |
| Webpage | `<iframe src="#artifact/id/index.html" title="Dashboard" height="600"></iframe>` |

Prefer date smart elements whenever possible in authored Markdown.

- Date: `#date/2026-10-15`
- Local date-time: `#date/2026-10-15T09:30`
- Named timezone: `#date/2026-10-15T09:30[America/Los_Angeles]`
- Offset timestamp: `#date/2026-10-15T09:30:00-07:00`
- UTC timestamp: `#date/2026-10-15T16:30:00Z`
- Date interval: `#date/2026-10-15/2026-10-18`
- Timed interval: `#date/2026-10-15T09:30/2026-10-15T10:30`

Copy returned saved-record and attachment handles unchanged into prose; handles
inside code remain literal. An action with `Action.occurrence.projected: true`
has a transient handle; do not save that handle as a durable reference. After an occurrence is edited, use
the saved action's returned handle.
Attachment paths are temporary retrieval metadata, not durable references. Read
saved attachments through validated `Attachment.filePath` values; import or remove them through artifact mutations.
