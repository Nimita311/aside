# Date references

Dates in Markdown use Aside's `#date/<ISO-value>` handle convention. They are
content references to time, independent of record identities and scheduling.

| Value | Example |
| --- | --- |
| Calendar date | `#date/2026-10-15` |
| Floating local clock | `#date/2026-10-15T09:30` |
| Named timezone | `#date/2026-10-15T09:30[America/Los_Angeles]` |
| Offset timestamp | `#date/2026-10-15T09:30:00-07:00` |
| UTC timestamp | `#date/2026-10-15T16:30:00Z` |
| Date interval | `#date/2026-10-15/2026-10-18` |
| Timed interval | `#date/2026-10-15T09:30/2026-10-15T10:30` |

The payload is an extended ISO 8601 subset: real Gregorian dates in years
0001–9999, clocks to minutes or seconds, optional 1–3 fractional second digits,
and optional `Z` or `±HH:MM` offsets. Timed values also accept Temporal-style
bracketed IANA zone names, with no offset required. Hours are 00–23, minutes
and seconds 00–59.
Intervals have exactly two complete endpoints, both calendar dates, floating
clocks, or resolved timestamps (offset or named-zone values). End must be at or
after start; resolved endpoints compare instants. Slashes inside zone brackets
belong to the zone name. Named-zone intervals repeat the zone on each endpoint,
e.g. `#date/2026-10-15T09:30[Asia/Tokyo]/2026-10-15T10:30[Asia/Tokyo]`.
Unknown offset `-00:00`, other bracket annotations, durations,
repeating intervals, and reduced dates are unsupported.

Named clocks follow Aside's scheduling rules: repeated clocks resolve to their
first occurrence; nonexistent clocks at forward transitions stay literal.
An explicit numeric offset can choose a repeated occurrence and must agree
with the named zone. `Z` denotes a UTC instant with zone context. Zone names
must be recognized by the runtime's IANA timezone database.
Converted browser dates must remain within years 0001–9999; values outside
that display and navigation range stay literal.

Agents prefer smart elements whenever possible in authored record content;
MCP's write guides include syntax examples.
Scheduling metadata keeps its existing schema and is not inferred from prose.

Bare handles render as neutral inline chips.
Malformed handles, code, and escaped hashes stay literal. Chips show absolute
dates in the browser locale and respect the date, time-style, and clock
preferences (see [web display preferences](../webapp/spec.md#date-and-time-display-preferences));
hover and accessible descriptions retain the original ISO endpoints and
weekdays. Date-only and floating values
stay authored; offset and named-zone timestamps display and navigate in the
browser timezone. Named-zone chips use a UTC timestamp for HTML's `datetime`
attribute, retaining the bracketed value in their handle and hover text.
Display preference changes update chips in place. Copying a chip restores its
handle, keeping the original timezone, offset, and precision. Selecting the
complete visible label also copies the handle; partial selections copy text.

An ordinary click closes the reader and jumps to the target in the timeline,
preserving a project/action filter and clearing a single-entry view. Date-only
targets land on that day's latest entry; timed targets land at or before the
clock, with the existing boundary and unread-week safeguards. Intervals jump
to their start; they do not filter the timeline to a range. Native links use
`date/<start>[/<end>]` routes, optionally under a project/action route, so
copy-link, new-tab navigation, reload, and browser history retain the target.
Date references do not create relationships, records, reminders, or schedules.
