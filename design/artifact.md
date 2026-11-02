# Artifact

An artifact holds durable content meant to be maintained and updated, such as a plan or guide. An entry records an event and its context: what happened or was decided at a particular time. For example, an entry records a plan review and links to the artifact containing the plan.

Artifacts are edited in place; their stable handles open the latest content. Git provides committed history.

## Identity and storage

Markdown records live at `artifacts/<year>/<id>.md`. IDs follow the [entity identity rules](identity.md): `YYYY-MM-DD-{slug-of-name}`, derived at creation. The ID and creation timestamp remain fixed when the name or content changes.

An optional sibling directory with the same ID holds attachments.

```text
artifacts/
  2026/
    index.yaml
    2026-10-02-design-review.md
    2026-10-02-design-review/
      desktop.png
      mobile.png
      brief.pdf
```

Each year's `index.yaml` contains IDs and authored descriptions, newest first by creation time. Descriptions live only in the index.

## Record format

| Field | Requirement | Meaning |
|---|---|---|
| `name` | Required | Display name |
| `created` | Required | Creation timestamp, `YYYY-MM-DDTHH:MM` |
| `attachments` | Optional | Server-maintained list of exact attachment filenames; omitted when empty |

```markdown
---
name: Design review
created: 2026-10-02T10:00
attachments:
  - brief.pdf
  - desktop.png
  - mobile.png
---

![Desktop](#artifact/2026-10-02-design-review/desktop.png)
![Mobile](#artifact/2026-10-02-design-review/mobile.png)
```

Attachments are ordinary files, with no separate records. The `attachments` field indexes their exact filenames for software and browsing; MCP maintains it from the files, rather than accepting it as an authored field.

## References and rendering

The authored Markdown content of any record can link to artifacts and their attachments through handles. These inline references are authoritative and appear only in content, never in metadata. Handles are preferred to raw file links; raw links remain supported.

| Form | Rendering |
|---|---|
| `#artifact/<id>` | Link labeled with the artifact's display name |
| `#artifact/<id>/<filename>` | Link labeled with the exact filename |
| `[Label](#artifact/<id>/<filename>)` | Link with the supplied label |
| `![Alt text](#artifact/<id>/<filename>)` | Embedded image with the supplied alt text |

A Markdown link can also target the artifact itself. Handles in inline code or code blocks are displayed as text and create no links, backlinks, or associations.

Attachment handles use exact filenames, including any extension, directly inside the same-ID directory: `artifacts/<year>/<id>/<filename>`. Renaming a file changes its attachment handle and requires updating references.

Reserved characters are URI-escaped in attachment handles; resolution recovers the exact filename.

Backlinks derive from inline references, counting each saved record source once. Artifact backlinks target the artifact itself; attachment backlinks target the exact attachment. Attachments never originate links and their contents are not scanned for references, including when a file is the artifact's primary content. Record self-references are excluded; a record can reference its own attachments. Referencing an attachment associates its parent artifact with the source's context. Project/action associations come from the referencing entry's tags or a direct reference in a project/action body.

Any file format can be stored and downloaded. The reader previews supported formats. Image syntax embeds image targets; links open other formats in the reader.

## File content

When the Markdown body is empty and `attachments` contains exactly one filename, the file is the artifact content. A reference to the artifact opens that file; image syntax can embed it when it is an image. A nonempty body supplies Markdown content. Empty artifacts with zero or multiple attachments open the artifact page, which lists the available attachments.

```yaml
---
name: Design review
created: 2026-10-02T10:00
attachments:
  - brief.pdf
---
```

The rule is evaluated from the current body and attachment index. Adding a second attachment makes the artifact a collection; adding a body makes it a Markdown document. Updating a file in place or replacing it with a new filename preserves the artifact ID and handle. Direct attachment handles remain tied to their filenames.

## System integration

MCP creates, queries, updates, and shows artifacts, maintains indexes, and imports or removes attachments. It reconciles the attachment index when loading an instance, after file writes, and when external file changes are observed. Only immediate regular files belong to the index; subdirectories, symlinks, and temporary import files are excluded. Index reconciliation preserves authored content and custom front matter. Source paths are temporary import inputs. Metadata/full queries and create/update receipts expose each indexed attachment’s exact filename, canonical handle, and validated absolute path to its saved copy. Only existing ordinary regular files contained in the managed artifact directory and instance receive paths; missing or invalid files receive diagnostics. Agents may read those paths with existing file or format-specific tools, without bypassing MCP for record operations or attachment changes. Paths are current retrieval metadata, never persisted references or a promise of immutable content or continued existence. Validation checks record identity, attachment index consistency, references, and referenced files.

The webapp includes artifacts in search and uses the existing reader. It lists attachments from front matter and fetches their content only when selected or referenced. The file server does not enumerate attachment directories. HTML attachments open as sandboxed webpage previews with [instance query access](../webapp/spec.md#iframe-graphql). Markdown iframe embeds can target attachment handles or external pages. See [webpage embeds](../webapp/spec.md#webpage-embeds) for authoring and isolation.

Existing saved content can be promoted into artifact records.
