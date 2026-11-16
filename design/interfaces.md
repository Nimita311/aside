# Interfaces

## Responsibilities

Agents capture and maintain records and author advanced queries and pages.
People browse, inspect, search, follow references, and pin views. Agents actively
recognize work and capture opportunities while preserving the user's voice and
intent. Record creation requires approval; a direct creation request supplies it.
Instance instructions customize behavior only within their instance.

The agent skill provides concise orientation and task discovery. Task guides own
workflow and authoring guidance; the executable schema owns field contracts.
Guides and schema are discoverable without selecting an instance. MCP is the
default record interface; explicit user requests may use file-based operations.
Failures are reported rather than silently bypassed through another interface.

## Public interfaces and extensibility

| Audience | Supported interface |
| --- | --- |
| Agents | MCP and CLI |
| People | CLI and webapp |
| Software integrations | Explicitly selected stable HTTP endpoints, such as the GraphQL query interface |
| HTML artifacts | [Artifact SDK](#artifact-sdk) |

Other webapp REST endpoints are private implementation details, without a public
compatibility contract. Public documentation, agent guides, and examples teach
the supported interfaces, not internal routes. Artifact authoring uses the SDK
rather than discovering the webapp's REST endpoints.

Local and remote consistency applies to supported interfaces. Data and file
extensibility follows the [system design](system.md#data-structure).

## Artifact SDK

Aside provides `window.aside` before indexed HTML artifact scripts run. A private
message channel delegates requests to the parent webapp; artifacts receive
results without credentials or a separate authentication session.

| Method | Contract |
| --- | --- |
| `aside.query(document, variables?, options?)` | Read-only GraphQL record queries in the selected instance; returns `data`, `errors`, and completeness metadata. Options may select `operationName`. |
| `aside.resource(reference)` | Reads an indexed attachment from the selected instance; returns a `Blob` with its media type. |

Resource references are relative attachment filenames, such as `./chart.png`, or
canonical attachment handles for other artifacts. Relative names resolve against
the source artifact's attachment directory. The parent validates containment and
attachment membership; arbitrary URLs, filesystem paths, and other instances are
outside the SDK contract.

Requests are bounded and tied to the active preview and selected instance.
Replacing or navigating the preview, or switching instances, revokes access and
cancels pending work. GraphQL errors remain in the response; transport, resource,
and scope failures reject the promise. Failed reads never change the selection.
External frames, unindexed files, and standalone HTML receive no SDK capability.

### HTML authoring

Inline startup JavaScript and CSS. Use `aside.query()` for records and
`aside.resource()` for file contents, including the artifact's own attachments.
Protected resource URLs in `src`, `href`, CSS, or direct `fetch()` calls are
outside the authoring contract.

Resource Blobs can be read with `.text()` or displayed using Blob URLs:

```html
<img id="chart" alt="Project chart">
<script>
  async function load() {
    const blob = await aside.resource("./chart.png");
    document.getElementById("chart").src = URL.createObjectURL(blob);
  }
  load().catch(console.error);
</script>
```

Release Blob URLs when their content is replaced. Bootstrap follows the
[hosting design](hosting.md#sandboxed-artifacts).

## Browsing

The entry flow is the primary experience. Native reading, recall, and record
inspection work without custom dashboards. A record page shows authored content
and derived context without presenting another editable copy. Search languages
remain explicit; changing modes never reinterprets the query automatically.

Query source, project/action focus, literal quick search, and date range compose
independently before pagination. Removing one preserves the others. Failed or
incomplete queries never broaden results silently. Pins bookmark mutable browsing
state without changing their underlying query definitions. Sidebar membership is
explicit; merely creating an artifact does not register a view.

History restores browsing state and reading position. Filtering stays anchored
to the reader's engaged entry or moment. Newer navigation supersedes older
asynchronous work. Failed reads retain readable content and offer scoped retry;
incomplete history or search is never presented as verified absence.

## Presentation

The Reader remains stable while automatic side panels use available space. A
compact control interface provides equivalent navigation when panels retract.
Responsive changes preserve state, reading anchors, and equivalent focus. Full
HTML pages use the viewport with navigation still available.

Markdown follows GitHub's readable hierarchy and spacing. Deliberate adaptations
keep headings clear of timeline dividers and give wide blocks spare margin space
without widening prose. Ordinary record content stays inspectable, including
diagnostics, original identifiers, and source values.

References follow their context: pills group project/action metadata above
entries; prose references inherit the sentence's ink and emphasis; list rows
align icons and names; titles use a selectable icon and name without a pill.
Type and lifecycle live in the icon. Deadlines remain separate facts. Selection
adds a neutral field without changing text metrics; selected prose restores its
underline on hover. Hover links matching references, while keyboard focus stays
explicit. The [entity styles specimen](../webapp/mock/entity-forms.html) defines
the finalized appearance and interaction states.

Transitions preserve continuity and accurate visible positions around a stable
anchor. Reduced-motion and disabled-animation preferences remove motion.
Interactive controls retain native keyboard/link behavior, meaningful accessible
names, and visible focus; hidden controls and departure visuals are inactive.

Native action timelines are a direction for work review, separate from entry
history. They distinguish schedule, deadline, missing dates, and lifecycle without
requiring a custom dashboard.

## Browser boundary

The access boundary, proxy contract, and browser request protections follow the
[hosting design](hosting.md).

Authored pages execute in isolated frames without access to app DOM, storage, or
general credentials. Importing indexed HTML trusts its scripts to read the
selected instance and potentially send that data externally. The
[artifact SDK](#artifact-sdk) defines their supported access. Directly served
HTML and SVG also retain sandbox isolation. Rendering, indexing, and record writes
never initiate geocoding.

## Human output

CLI reports separate facts from evaluated health checks, retain complete
diagnostics and actionable recovery, and escape authored control characters.
Machine output preserves native values, partial results, and errors. Loading,
offline, incomplete data, and failed operations remain distinguishable; feedback
must not move the reading surface or steal focus.
