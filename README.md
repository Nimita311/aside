# Aside

**Personal context for AI natives**

## Simply productive

Capture. Organize. Deliver.

| Concept | Purpose |
| --- | --- |
| **Notes** | Capture dated entries in a continuous timeline. |
| **Projects** | Organize those entries and their actions by theme. |
| **Actions** | Deliver on your plans with calendar sync and agent delegation. |

**Every note, project, and action lives in a `.md` file.**
No database. No proprietary format.

## An aside in your agent session

- **Start in your flow.** You're writing the script for a short comedy sketch with your agent. That's the main show.

- **Make an aside.**

  > I like this silent ending. Save the idea and our reasoning with Aside.
  > Robin's free Sunday afternoon. Block an hour for us to rehearse.

  The idea becomes a dated entry in your timeline, linked to the sketch project and rehearsal action.

- **Query expressively.**

  > Get me up to speed for improv with Robin later tonight. Where did we leave
  > the sketch, and did we ever try that silent ending?

- **See the whole picture.** Open the web app with `aside show`, or ask your agent:

  > Show me the sketch project.

  Browse the full timeline or view the same entries by project, alongside their actions.

- **Automate and delegate.**

  > Every Friday, prepare a rehearsal brief from the sketch project: recent ideas,
  > what we've tried, and what's still open.

## Make it yours

- **Shape your agent.** `aside.md` is your `AGENTS.md` for Aside.
- **Connect your software.** Query and update your context with the CLI and expressive GraphQL.
- **Build rich views.** Create HTML artifacts that run in the web app with access to your context.

## Get started

Supported on macOS. Requires Node.js 22.12+ and npm; Node.js 24 recommended.
Calendar sync requires macOS 14+ and the Xcode Command Line Tools.

1. **Build from source.**

   ```sh
   ./build.sh
   ```

2. **Install the Aside skill and MCP integration.**

   | Agent | Install |
   | --- | --- |
   | [Codex](https://openai.com/codex) | `aside plugin install --agent codex` |
   | [Claude Code](https://claude.ai/code) | `aside plugin install --agent claude` |

   Check your installation with `aside plugin status`.

3. **Optionally start the daemon with launchd at login.**

   ```sh
   aside daemon install
   ```

4. **Ask your agent to get started.**

   > Set me up with Aside and show me what it can do.

*Let AI be useful; make your life beautiful.*
