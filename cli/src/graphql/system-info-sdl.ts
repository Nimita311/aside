export const systemInfoSDL = `
    "System operation and integration status, independent of instance content. Sections are inspected only when selected."
    type SystemInfo {
      "Version of this Aside server."
      build: SystemBuild!
      "Running daemon status, or null outside a daemon host. Contains no instance catalog."
      daemon: SystemDaemonInfo
      "Existing CLI installation and agent plugin diagnostics. Selecting this section may run bounded vendor listing commands; it never installs or changes plugins."
      installation: SystemInstallationInfo
      "Search prerequisites. This does not run inference or create indexes."
      search: SystemSearchInfo!
      "Global Calendar authorization and destinations. Never requests permission or reads instance sync state."
      calendar: SystemCalendarInfo
    }
    "Existing Aside build identity."
    type SystemBuild {
      "Aside application version."
      version: String!
      "Build timestamp in Unix milliseconds; zero when running unbundled source."
      builtAt: Float!
    }
    "One existing CLI diagnostic check and its recovery guidance."
    type SystemCheck {
      "Stable check identifier from the CLI report."
      code: String!
      "Human-readable check name."
      label: String!
      "Whether this check passed."
      passed: Boolean!
      "Reported problems; empty when none."
      problems: [String!]!
      "Suggested recovery steps; never executed by inspection."
      fixes: [String!]!
      "Related filesystem path, when reported."
      path: String
      "Report group, when present."
      group: String
    }
    "Runtime counters and saved startup configuration already reported by daemon status."
    type SystemDaemonInfo {
      "Running daemon process ID."
      pid: Int!
      "Connected daemon clients, including the connection making this query."
      connections: Int!
      "Connected web application tabs."
      tabs: Int!
      "Daemon log file path."
      logPath: String!
      "Saved login job information."
      startup: SystemDaemonStartup!
      "GraphQL log writer counters for this daemon process."
      graphqlLogging: SystemGraphQLLogging!
      "Existing daemon status diagnostic checks."
      checks: [SystemCheck!]!
    }
    "Saved login job; presence does not prove the job is loaded by the operating system."
    type SystemDaemonStartup {
      "Saved job file path, or null when absent."
      path: String
      "Whether a saved job file exists, including an unrecognized file."
      present: Boolean!
      "Saved program arguments, or null when no recognized job exists."
      program: [String!]
      "Build timestamp in Unix milliseconds, or null when no recognized job exists."
      builtAt: Float
    }
    "Existing process-wide GraphQL log writer counters."
    type SystemGraphQLLogging {
      "Bytes awaiting log writes."
      queuedBytes: Float!
      "Log entries dropped during this process lifetime."
      dropped: Float!
      "Log writer errors during this process lifetime."
      errors: Float!
    }
    "Existing plugin status report for the GraphQL package; does not prove a running agent session has loaded it."
    type SystemInstallationInfo {
      "Source checkout inspected, or null when it could not be resolved."
      checkout: String
      "Existing labeled CLI, build and marketplace information."
      information: [SystemInstallationInformation!]!
      "Existing installation and plugin checks with recovery steps."
      checks: [SystemCheck!]!
      "Claude and Codex executable discovery and registration results."
      agents: [SystemAgentPlugin!]!
    }
    "One labeled value from the existing CLI installation report."
    type SystemInstallationInformation {
      "CLI report section."
      group: String!
      "Information label within the section."
      name: String!
      "Reported value, or null when absent."
      value: String
    }
    "Detected agent executable and existing Aside plugin registration diagnostics. Presence does not establish authentication or inference readiness."
    type SystemAgentPlugin {
      "claude or codex."
      name: String!
      "Detected agent executable path, or null when missing."
      path: String
      "Claude registration state; null for Codex or failed inspection."
      claude: SystemClaudePlugin
      "Codex registration state; null for Claude or failed inspection."
      codex: SystemCodexPlugin
    }
    "Existing Claude plugin registration state."
    type SystemClaudePlugin {
      "Registered marketplace path, or null when not registered."
      marketplacePath: String
      "Whether the marketplace points to the inspected checkout."
      marketplaceHere: Boolean!
      "Whether the Aside plugin is installed at user scope."
      userInstalled: Boolean!
      "Whether the user-scope installation is disabled."
      userDisabled: Boolean!
      "Whether the plugin is also installed in another scope."
      otherScopes: Boolean!
      "Whether installed source, skills or MCP configuration differ from the package."
      needsRefresh: Boolean!
      "Existing installations reported by Claude."
      installations: [SystemClaudeInstallation!]!
      "Other installed plugins from the same marketplace."
      otherMarketplacePlugins: [String!]!
    }
    "One existing Claude plugin installation and its scope."
    type SystemClaudeInstallation {
      "Installed plugin identifier."
      id: String!
      "Installation scope reported by Claude."
      scope: String!
      "Project directory for project or local scope, when reported."
      projectPath: String
      "Reported enabled state, or null when unknown."
      enabled: Boolean
      "Plugin loading errors reported by Claude, when present."
      errors: [String!]
      "Installed plugin directory, when reported."
      installPath: String
      "Source directory used to load the plugin, when reported."
      readFromFolder: String
      "Installed MCP server wiring, when reported."
      mcpServers: [SystemPluginMCPServer!]
    }
    "Existing installed MCP command wiring."
    type SystemPluginMCPServer {
      "MCP server registration name."
      name: String!
      "Configured executable, when reported."
      command: String
      "Configured command arguments, when reported."
      args: [String!]
    }
    "Existing Codex plugin registration state."
    type SystemCodexPlugin {
      "Registered marketplace path, or null when not registered."
      marketplacePath: String
      "Whether the marketplace points to the inspected checkout."
      marketplaceHere: Boolean!
      "Whether the Aside plugin is installed."
      installed: Boolean!
      "Whether the installation is disabled."
      disabled: Boolean!
      "Whether cached plugin files match the inspected package."
      current: Boolean!
      "Other installed plugins from the same marketplace."
      otherMarketplacePlugins: [String!]!
    }
    "Search capability status independent of an instance."
    type SystemSearchInfo {
      "Check semantic search prerequisites without inference, index creation, downloading models, or starting services."
      semantic: SemanticSearchAvailability!
    }
`;
