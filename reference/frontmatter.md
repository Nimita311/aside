# Frontmatter schema

Sources: [record types](../cli/src/core/types.ts) · [parsers](../cli/src/core/parser.ts) · [validation](../cli/src/core/validator.ts).

## Shared values

| Value | Format |
| --- | --- |
| Creation/closure timestamp | Real Gregorian floating minute, `YYYY-MM-DDTHH:MM` |
| Schedule/deadline | `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM` |
| Named zone | Recognized IANA name, not a numeric offset |
| Duration | Positive fixed ISO days/hours/minutes/seconds totaling whole minutes; `P1D` is 24 elapsed hours |
| Record ID | Entry creation timestamp; named entity creation date plus normalized name slug |

| Item | Behavior |
| --- | --- |
| Schema scope | Valid authored records; tolerant reads may recover values with diagnostics. |
| Ordinary edits | Preserve custom metadata and bodies. |
| Descriptions | Stored in yearly indexes, not entity frontmatter. |
| Rename | Preserves IDs and filenames. |
| Slug letters | Retain Unicode letters, digits, combining marks; require a letter or digit. |
| Slug normalization | Fold case/NFKC variants; collapse other runs to `-`; cap UTF-8 length. |
| Empty/missing fields | Generally absent; `recurrence: []` remains meaningful. |
| API clearing | See [GraphQL writes](graphql.md#writes). |

## Instance manifest

File: `<instance>/aside.md`. Its Markdown body contains instance instructions.

| Field | Type | Requirement |
| --- | --- | --- |
| `id` | String | Required stable hostname label: 1–63 lowercase ASCII letters, digits, or hyphens; alphanumeric ends |
| `name` | String | Display name; supplied by creation tools |
| `description` | String | Discovery summary; supplied by creation tools |
| `version` | String | Software version recorded at creation |
| `automations` | Mapping | Optional [named automations](#automations) |
| `config` | Mapping | Optional [instance settings](configuration.md#instance-settings) |

## Weekly note files

File: `notes/<Monday-year>/<Monday-date>.md`.

| Field | Type | Requirement |
| --- | --- | --- |
| `week` | Number | Week number |
| `week_start` | Date string | Monday of the file's week |
| `week_end` | Date string | Sunday of the file's week |

## Entry metadata

| Item | Behavior |
| --- | --- |
| Weekly grouping | Monday–Sunday, including across year boundaries; newest entries first. |
| Entry preamble | Horizontal rule, then fenced YAML tagged `entry`; metadata is inside the weekly body. |
| Entry body | Markdown after the fence. |
| Associations | Inline mentions do not replace explicit tags. |

| Field | Type | Requirement |
| --- | --- | --- |
| `created` | Timestamp | Required; also the entry ID |
| `projects` | String list | Optional explicit project IDs |
| `actions` | String list | Optional explicit action IDs |

## Projects

File: `projects/<creation-year>/<id>.md`; body is maintained project context.

| Field | Type | Requirement |
| --- | --- | --- |
| `name` | String | Required display name |
| `created` | Timestamp | Required creation time |
| `ended` | Timestamp | Optional closure time; absent means open |
| `related_projects` | List of mappings | Optional `{project: <id>, description: <text>}` directional links |
| `automations` | Mapping | Optional [named automations](#automations) |

## Actions

File: `actions/<creation-year>/<id>.md`; body is action context/instructions.

| Field | Type | Requirement |
| --- | --- | --- |
| `name` | String | Required display name |
| `created` | Timestamp | Required on saved records |
| `scheduled` | Schedule | Optional commitment; absent unresolved ordinary actions are backlog |
| `deadline` | Schedule | Optional urgency, independent of schedule |
| `resolution` | Enum | Optional `done` or `cancelled` |
| `calendar` | String | Optional readable destination name |
| `calendar_account` | String | Optional readable account qualifier |
| `duration` | Duration | Optional event length; see [default](configuration.md#behavior-defaults) |
| `timezone` | Named zone | Optional qualifier for timed schedule; absent means floating |
| `location` | String | Optional bare [location handle](urls.md#location-handles), quoted in YAML |
| `recurrence` | List | Optional [schedule history](#recurrence); present means template, including `[]` |
| `occurrence` | Mapping | Optional immutable [occurrence provenance](#recurrence) |
| `delegation` | Mapping | Optional [agent execution](#delegation) |

| Item | Behavior |
| --- | --- |
| Template | No `scheduled`, `resolution`, or `occurrence`. |
| Ordinary/saved occurrence status | Resolution first, then schedule. |
| Resolved action | May retain schedule. |
| Project associations | Derived from entry context; occurrences also inherit live template associations. |
| Calendar match | Unique readable name or name/account pair. |
| Invalid destination | Missing, ambiguous, or read-only calendar blocks sync. |
| Clear destination | Remove owned event; preserve schedule. |
| Primary location | Independent of body mentions; synchronizes action → Calendar only. |

### Recurrence

| Item | Behavior |
| --- | --- |
| `dtstart` | Required date or minute-precision wall clock. |
| `timezone` | Optional IANA zone; omitted for all-day rules. |
| `rrule` | Required; contains `FREQ`. |
| Rule fields | `INTERVAL`, `COUNT`, `UNTIL`, `BYDAY`, `BYMONTHDAY`, `BYMONTH`, `BYWEEKNO`, `BYYEARDAY`, `BYSETPOS`, `BYHOUR`, `BYMINUTE`, `BYSECOND`, `WKST`; validated combinations. |
| Rule ending | Inclusive `UNTIL` or `COUNT`, never both. |
| Schedule history | Ordered, nonoverlapping. |

```yaml
recurrence:
  - dtstart: "2026-10-02T09:00"
    timezone: America/Los_Angeles
    rrule: "FREQ=WEEKLY;BYDAY=FR"
```

| Item | Behavior |
| --- | --- |
| `occurrence.template` | Required template action ID. |
| All-day `original` | Literal date. |
| Floating `original` | Literal wall minute. |
| Zoned `original` | Exact UTC instant with seconds and `Z`; original IANA zone retained in `timezone`. |
| Schedule edits | Do not change provenance. |

### Delegation

| Item | Behavior |
| --- | --- |
| `delegation.run` | Required `{model, prompt}`; model from [execution catalog](configuration.md#execution-settings). |
| `delegation.run.prompt` | Direct primary artifact handle; no literal text or attachment handle. |
| `delegation.timeout` | Optional; [default and bounds](configuration.md#behavior-defaults). |
| Scheduling | Supplied by action; no script, schedule, enabled, or overlap declaration fields. |

## Artifacts

Record: `artifacts/<creation-year>/<id>.md`. Attachments: immediate regular files under sibling `<id>/`.

| Field | Type | Requirement |
| --- | --- | --- |
| `name` | String | Required display name |
| `created` | Timestamp | Required creation time |
| `attachments` | String list | Optional exact filenames, maintained by attachment operations |

| Item | Behavior |
| --- | --- |
| Primary content | Empty body + one attachment → file; otherwise Markdown body. |
| Attachment names | Single safe filename; no reserved staging names; exact case/Unicode disk spelling. |
| Retrieval paths | Temporary metadata; author [handles](urls.md#record-handles), not absolute retrieval paths. |

## Automations

| Item | Behavior |
| --- | --- |
| Declaration location | Instance/project `automations` map: job name → declaration. |
| Invalid saved job | Retained for inspection with diagnostics; valid siblings continue. |

| Field | Type | Requirement |
| --- | --- | --- |
| `schedule` | Mapping | Exactly one form below |
| `run` | Mapping | Either `{script, args?}` or `{model, prompt}` |
| `enabled` | Boolean | Optional |
| `timeout` | ISO duration | Optional positive fixed duration, maximum 2,147,483,647 ms |
| `overlap` | Enum | Optional `latest` or `skip` |

| Schedule form | Fields |
| --- | --- |
| Cron | `cron`: five fields; optional IANA `timezone`; day-of-month/weekday OR semantics |
| RRULE | `rrule` with `FREQ`, wall-clock `dtstart` to minutes or seconds, optional `timezone`; UTC `UNTIL`, exclusive with `COUNT` |
| One time | `at`: ISO timestamp with explicit offset or `Z` |

| Item | Behavior |
| --- | --- |
| Script arguments | String list; no shell. |
| Agent prompt | Direct primary artifact handle. |
| Unknown fields | Declaration errors. |
| Execution settings | [Models, cwd, defaults, launch arguments](configuration.md#execution-settings). |
| GraphQL representation | Structured artifact links and collection patches; distinct from persisted YAML shapes. |

## Year indexes

| Item | Behavior |
| --- | --- |
| File | `<collection>/<year>/index.yaml`. |
| Shape | YAML list of `{id, description}`, newest first. |
| Description ownership | Authored description appears only in its index. |
| Maintenance | Updated by writes; validated against records. |
| Entry indexes | Do not duplicate tags or content. |
