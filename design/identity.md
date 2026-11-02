# Entity Identity

Every entity has a `created` field using the [timestamp format](system.md#design-and-implementation-rules). The entity ID is derived:

- **Entry ID:** the `created` value itself, such as `2026-05-02T14:30`.
- **Project, action, and artifact ID:** `{YYYY-MM-DD from created}-{slug of name}`, such as `2026-05-02-migration`.

Named entities have a `name` field containing the human-readable display name set at creation. Their ID is also the filename without `.md`. IDs and filenames remain fixed when the display name changes.

Entries have no `name`: they are temporal records identified by their creation timestamp.

## Slug Rules

The slug provides a stable handle for finding and referencing an entity. The exact human-facing name is preserved in the `name` field. Canonicalization makes case, Unicode normalization, and presentation variants converge to the same identifier.

- **Valid filename.** Letters, digits, and combining marks from any script are retained; other runs collapse to a single dash. UTF-8 byte length is capped. A name with no letters or digits is rejected.
- **Canonical filename.** The slug is lowercased and Unicode-normalized, then stored verbatim as the filename. Identity comparisons remain consistent on case- and normalization-insensitive filesystems.
- **Presentation variants.** NFKC normalization folds characters that differ only in presentation into their plain forms, including fullwidth `Ｑ３`, the `ﬁ` ligature, and Arabic presentation forms.
