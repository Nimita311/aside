# URL shapes

Sources: [browser routes](../webapp/src/route.ts) · [CLI targets](../cli/src/commands/show-target.ts) · [HTTP paths](../cli/src/web/server.ts) · [default origin](configuration.md#environment-and-platform).

## Instance addresses

| Item | Behavior |
| --- | --- |
| `/<address>/…` | One exact instance directory. |
| Unique independent instance / primary | Bare manifest ID. |
| Linked worktree | `<id>~<hash>`. |
| Independent duplicate-ID groups | All suffixed; ambiguous bare address unavailable. |
| Hash | First 16 hexadecimal SHA-256 characters of canonical directory. |
| Suffixed alias | Accepted for every instance; collisions fail without arbitrary selection. |
| Moved directory | Suffix changes; durable ID stays fixed. |
| Alias resolution | Canonicalize visible address; preserve view. |
| Data/control requests | Retain exact directory alias; another copy cannot redirect open tab. |
| Global resources | `/-/`. |

## Browser routes

Paths below are relative to `/<address>/`, except the chooser `/`.

| Shape | Destination |
| --- | --- |
| `/` | Global instance chooser |
| Empty | Default entry flow |
| `<entry-id>` | Jump within the default flow |
| `project/<id>` / `action/<id>` | Entry flow focused on that entity |
| `project/<id>/<entry-id>` / `action/<id>/<entry-id>` | Entry jump in the focused flow |
| `project/<id>/detail` / `action/<id>/detail` | Complete record page |
| `detail` | Instance record page (Overview) |
| `entry/<entry-id>` | Single-entry route |
| `artifact/<id>[/<filename>]` | Artifact or exact attachment reader |
| `asset/<path>` | Instance-root-relative supporting file |
| `project/<id>/artifact/<artifact-id>[/<filename>]` | Content page retaining project-flow return context; actions use the same shape |
| `project/<id>/asset/<path>` | Supporting file with project-flow return context; actions use the same shape |
| `date/<start>[/<end>]` | Calendar target, optionally under a project/action prefix |

| Item | Behavior |
| --- | --- |
| Entry ID | Timestamp, distinct from named record IDs. |
| Unknown route | Default flow. |
| Native action timeline | No implemented route. |

| Query parameter | Value |
| --- | --- |
| `source` | Exact indexed artifact attachment handle containing an entry query definition |
| `search` | One trimmed case-insensitive literal entry phrase |
| `range` | Full `#date/<start>/<end>` interval |
| `order` | `CREATED_ASC` or `CREATED_DESC` override |

| Item | Behavior |
| --- | --- |
| Flow conditions | Source, focus, phrase, range compose before pagination. |
| Content navigation | Retains originating flow as return context. |
| Lookup drafts | Not URL state. |
| Back/Forward | Also restore reading anchors from history state. |
| IDs / filenames | One UTF-8 percent-encoded segment; timestamps retain `:`. |
| Asset paths | Encode each segment; preserve `/` separators. |
| Parameters | Normal query encoding, including handle `#`. |

## Aside URLs and show

| Item | Behavior |
| --- | --- |
| Aside scheme | `aside://<address>/…`; CLI show accepts supported record targets. |
| Project/action target | Detail reader. |
| Entry target | Jump to entry. |
| Artifact/attachment target | Content reader. |
| `?source=` / `?search=` | Exact query attachment / literal phrase; once each. |
| Full browsing bookmark | Use browser URL; CLI acceptance is narrower. |
| Pins | May store canonical Aside timeline targets. |
| `ShowInput` source | Optional `source`, `search`. |
| Entity focus | At most one `project` or `action`. |
| Content target | At most one `entry`, `asset`, `artifact`, or `detail`. |
| `filename` | Requires `artifact`. |
| `detail` | Requires matching project/action focus. |
| Empty input | Selected instance timeline. |
| `show` | Local CLI/stdio opens the host browser; HTTP MCP returns URL with outcome `RETURNED`. |
| `showUrl` | Return HTTP URL for the client browser to open. |
| HTTP URL | Localhost fallback for CLI/stdio; HTTP requests use forwarded origin or Host. |
| CLI `show --url` | Print URL without opening a browser. |

## Record handles

| Shape | Target |
| --- | --- |
| `#entry/<created>` | Entry timestamp |
| `#project/<id>` | Project |
| `#action/<id>` | Saved or projected action |
| `#artifact/<id>` | Artifact's primary content |
| `#artifact/<id>/<filename>` | Exact attachment |

| Item | Behavior |
| --- | --- |
| Attachment encoding | Percent-escape one filename segment; disk spelling remains literal. |
| Example | `design (final).png` → `#artifact/<id>/design%20%28final%29.png`. |
| Labels | Markdown link labels supported. |
| Literal content | Code and escaped hashes remain text. |
| Durable references | Prefer saved handles. |
| API IDs | Omit `#type/` prefix. |

## Date handles

| Item | Behavior |
| --- | --- |
| Shape | `#date/<value>` or `#date/<start>/<end>`. |
| Values | Complete Gregorian date, floating time, offset/UTC timestamp, bracketed IANA zone. |
| Precision | Years 0001–9999; minute/second clocks; up to 3 fractional digits. |
| Intervals | Ordered endpoints of the same date/floating/resolved category. |
| Date example | `#date/2026-10-15`. |
| Named-zone example | `#date/2026-10-15T09:30[Asia/Tokyo]`. |
| Offset example | `#date/2026-10-15T09:30:00-07:00`. |
| Interval example | `#date/2026-10-15/2026-10-18`. |
| Zone slashes | Within brackets, part of zone name. |
| Unsupported | `-00:00`, reduced dates, durations, repeating intervals. |
| Zone resolution | Offsets must agree; repeated clocks use first instant; gaps without valid instant remain literal. |
| Date/floating display | Authored fields. |
| Resolved display | Browser timezone. |
| Copy | Original handle, precision, offset, zone. |
| Navigation context | Preserve source/focus/search; periods apply independent range. |
| Date-only jump | Latest eligible entry on that day. |
| Timed jump | At or before the clock. |
| Missing history | Explicit recovery; no silent flow change. |
| Scheduling effects | None. |

## Location handles

| Item | Behavior |
| --- | --- |
| Shape | `#location/?geo=<coordinates>&postal=<components>`. |
| Required fields | `geo`, `postal`, or both; each at most once. |
| Geo | WGS-84 latitude/longitude within ±90/±180; optional altitude. |
| Geo qualifiers | `;crs=wgs84`; nonnegative `;u=` uncertainty in meters. |
| Postal | Slash-separated UTF-8 percent-encoded components; trailing slash allowed. |
| Postal escaping | `%2F` is a slash within one component; `+` stays plus. |

```text
#location/?geo=51.5034,-0.1276&postal=10%20Downing%20Street/London/
```

| Item | Behavior |
| --- | --- |
| Labels | Presentation only. |
| Geo / postal-only | Open saved point in Apple Maps / inert inline reference. |
| Copy / malformed values | Preserve authored handles/labels / remain literal. |
| Action `location` | One bare handle, YAML quoted, without Markdown label. |
| Geocoding | Explicit [GraphQL query](graphql.md#root-queries); never automatic during writes/rendering. |

## Calendar markers

| Item | Behavior |
| --- | --- |
| Ordinary event | `aside://<instance-id>/action/<encoded-id>`. |
| Lifecycle suffix | Optional `/done`, `/cancelled`, `/backlog`; aliases normalize to these. |
| Showing marker | Locate action without changing it. |
| Native recurrence | `aside://<instance-id>/series/<template>/<anchor-key>[/state]`. |
| Instance identity | Durable manifest ID; never browser directory suffix. |

## HTTP endpoints

| Public surface | Contract |
| --- | --- |
| `/mcp` | Streamable HTTP MCP; independent selections; `Mcp-Session-Id` identifies protocol state; DELETE ends the session; capacity pressure evicts least recently used idle sessions (404 on reuse). |
| `POST /-/api/instances/<address>/graphql` | Read-only [webpage queries](graphql.md#webpage-queries); `Content-Type: application/json`. |
| Local access | Loopback only; no Aside authentication. |
| Remote access | Deployment provides TLS and authentication for every route; [proxy contract](../design/hosting.md#proxy-contract). |
| Origin checks | Backend Host must be loopback; supplied Origin must match forwarded scheme/host or direct HTTP Host. |
| Internal routes | Webapp REST and asset paths are implementation details, not integration interfaces. |

### Webpage embeds

| Item | Behavior |
| --- | --- |
| Markdown syntax | `<iframe src="…" title="…" height="600"></iframe>`. |
| Targets | HTTP(S), relative instance path, exact artifact attachment handle. |
| Rejected targets | Invalid, credential-bearing, protocol-relative external URLs. |
| Frame policy | `sandbox="allow-scripts"`, no referrer, lazy loading. |
| Height | 70vh default; numeric 100–2000px; full-page HTML fills viewport. |
| External framing | Destination must permit framing. |
| Artifact SDK | Parent-fetched `srcdoc` bootstrap; queries and resources only for indexed HTML artifacts. |
| Direct HTML/SVG | File responses also carry sandbox CSP. |
