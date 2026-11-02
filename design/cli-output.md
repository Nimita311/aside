# CLI output

Human-facing reports separate concrete information from evaluated health checks.
Sections use short titles and visible dividers. Fields show one value per line,
with aligned labels. Entries use display names and keep the absolute path directly
beneath the name. Supporting lines have only one level of indentation (two spaces).
Names and values containing control characters are escaped so authored data cannot
impersonate a report section or check. No diagnostic is silently truncated.

Information contains paths, IDs, versions, counts, and selection values. It does
not substitute words such as configured, loaded, or enabled for a successful
check. Health contains `[OK]` and `[ERROR]` checks, with the actual problem and
recovery instructions on failure. Terminal checks may use color, honoring
`NO_COLOR`; redirected output remains plain text.

Daemon instance entries annotate three independent facts in a fixed order:
`(loaded, background, N active sessions)`. Only present states appear; a singular
session says `1 active session`. The display name and directory stay together,
including for duplicate names. Background means selected by the running daemon
for continuous loading. Sessions count live daemon connections that have used
the instance; browser tabs are counted separately. Older daemons without session
counts leave this annotation unknown. Loaded stores do not certify Calendar sync
or record integrity. Login job information describes the saved file and future
logins; it does not establish current launchd supervision.

Instance listings and daemon status report only ID clashes across distinct
canonical directories as instance health problems, once per conflicting valid ID
with all affected paths. Prune verified non-instances before listing. Individual
manifest and data diagnostics belong to `instance validate`; loaded state stays
an entry annotation. Healthy catalogues add no instance health checks, and listing
JSON contains instance metadata without per-file validation issues.

Commands with MCP equivalents use the same human text as the corresponding MCP
tool. CLI-only reports (`plugin status`, `daemon status` and instance listings, `instance validate`,
and `instance init`) use the shared report layout. Short action receipts and browser URLs
stay concise. Plugin install and remove print plain action receipts without headings
or passing checks; `--print` lists commands directly. Verification failures retain
their diagnostics and fixes. Operation errors appear once on stderr with readable
multiline diagnostics and recovery commands; control characters other than newlines
and tabs are escaped.

Human commands support `--json`. MCP itself uses its protocol and does not accept
this output flag. Help remains human-readable. JSON stdout contains exactly one
document with `schema_version: 1`, `command`, `ok`, `data`, `checks`, and
`diagnostics`. Native values and boolean check outcomes are preserved; JSON is
produced from operation results, never by parsing formatted text. Artifact results
use the native MCP `content` text blocks with their parse issues. No separate
JSON record schema is invented for existing text-only MCP tools.

Failures retain partial results and report all collected checks. Syntax and
operation failures without a result have null data and an error diagnostic.
Failed checks or an operation failure exit nonzero. JSON contains no ANSI escapes
or human progress messages. Subprocess and daemon logs go to stderr. `serve
--json` emits the initial URL result once and continues holding its connection;
later connection failures are reported on stderr. Foreground daemon execution is
process hosting, not a result-producing report.

Validation first requires a readable `aside.md` with a YAML front-matter marker.
If this prerequisite fails, report validation as blocked, explain the manifest
problem and how to select an instance, and state that data checks were not run.
Return only the prerequisite failure, with `dataChecksRun: false` in JSON; never
label unrun checks as passing. Recognized instances, including those with manifest
metadata errors, run all data checks and return `dataChecksRun: true`.

CLI syntax and help are defined together in a Commander.js command tree. Run
`aside --help`, `aside <command> --help`, or `aside help <command> <subcommand>`
to inspect it. Bare command groups show help; `aside --version` prints the CLI
version. Internal `daemon run` remains callable but is hidden from command lists.

Commands reject unknown options, excess positional arguments, duplicate flags
and nonrepeatable values, missing required options, empty paths, and conflicting
options. Repeatable options keep their input order. Required option arguments
follow Commander’s rules: the next token is the value even when it begins with
`-`; the equals form, such as `--body=-draft`, is also supported. `--` ends option
parsing, and everything after it is positional. Help follows Commander’s normal
precedence and bypasses required-option and conflict checks.
