# Location references

Locations in Markdown use `#location/?` handles with optional `geo` and `postal`
values; at least one is required. Geo follows the supported RFC 5870 WGS-84
payload, and postal follows ETSI's slash-separated address components. The
query-field wrapper is Aside-specific:

```text
#location/?geo=51.5034,-0.1276
#location/?postal=10%20Downing%20Street/London/SW1A%202AA/United%20Kingdom/
#location/?geo=51.5034,-0.1276&postal=10%20Downing%20Street/London/SW1A%202AA/United%20Kingdom/
[**Office**](#location/?geo=51.5034,-0.1276&postal=10%20Downing%20Street/London/)
```

Geo is latitude then longitude in decimal degrees, with valid ranges of ±90 and
±180. Optional altitude is a third coordinate in meters; `;crs=wgs84` and a
nonnegative `;u=` uncertainty in meters are supported. Postal components preserve
their authored order. Components are split before percent-decoding so `%2F`
remains a literal slash inside one component; `+` remains a plus sign. Spaces,
Unicode, and reserved characters use UTF-8 percent encoding. A trailing postal
slash is accepted and emitted by the canonical formatter. Duplicate fields,
unknown fields, invalid coordinates, and malformed encoding remain literal.

Provider IDs are neither used nor stored: addresses and places will use saved
geo for proximity matching, with postal text and labels only for display;
matching and map UI remain deferred.

Valid bare handles render as neutral inline chips in every Markdown reading
surface. An optional Markdown link label controls display only, with postal then
coordinates as the fallback. Geo chips link to that point in Apple Maps, their
pin around its point; postal-only chips remain inert, their pin dashed and
empty as pending, and explain that coordinates are unavailable.
Rendering never geocodes. Code, escaped or entity-encoded hashes, and malformed
handles stay literal. Link labels are presentation and are not scanned for
additional location values. Copying a complete chip or its complete visible
label restores the exact authored handle and any Markdown label formatting;
partial selections copy text.

Geocoding is an explicit agent action. For a postal-only mention, the agent calls
`Query.geocodeAddress` with decoded address or place text in `query`, including
city or address context when useful. A single `MKLocalSearch` lookup returns
address and point-of-interest candidates, with no separate geocoder or fallback.
The agent compares candidates, refines its query using available context, and
saves the chosen geo alongside postal. No results means the location was not
found for that query; the agent can refine and retry. Region is a hint, and there
is no per-request locale control. Candidate order is preserved; no candidate is
selected automatically.
For the same confirmed address, agents reuse existing postal spelling and
component order whenever possible when writing or enriching a mention.
Supplied geo is preserved unless an explicit edit replaces it. File watchers,
indexing, rendering, and record writes never initiate geocoding.

A valid postal-only element saves successfully. GraphQL write receipts include a
nonfatal `location_geo_missing` notice in `extensions.mutations[].notices`,
identifying the saved record and handle and directing the agent to the geocoding
API. The notice leaves the successful mutation and its saved changes intact and
creates no persistent validation error or scheduled work. The agent enriches the
same record through an ordinary edit. Ambiguous or failed geocoding leaves postal
content intact. Plain prose addresses are not automatically promoted into smart
elements.

## Action location

An action's optional `location` field holds one primary location, independently
of locations mentioned in its body. It accepts one bare `#location/?` handle;
Markdown display labels are not allowed in this field. Quote the handle in YAML
because an unquoted leading `#` starts a comment:

```yaml
location: "#location/?geo=51.5034,-0.1276&postal=10%20Downing%20Street/London/"
```

Omitting `location` on creation leaves it unset; on update, omission preserves it
and `null` clears it. Projected occurrences inherit their template's location;
occurrence edits can override or clear it, and saved occurrences retain their
own value. Action details display the same geo/postal chip used in content.

The action is authoritative for its Calendar event's location. Forward sync
derives the event location from this field, and an unset field clears it;
Calendar location edits are not imported into Aside. Body mentions do not choose
the event's location. Neither writing this field nor synchronizing Calendar
initiates geocoding; agents use the explicit lookup workflow above.

Calendar sync exports postal display text and latitude/longitude. Altitude and
uncertainty remain in the action handle; Calendar stores can discard altitude,
so synchronization does not require its readback.
