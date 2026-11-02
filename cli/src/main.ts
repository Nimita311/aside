#!/usr/bin/env node

import { errorLine, errorResult, outputState, writeOutput } from './commands/output.js';
import { CliParseError, parseCli } from './commands/options.js';
import { InstancePathError } from './core/instance.js';

let jsonRequested: boolean | undefined;
let graphqlRequested = process.argv[2] === 'graphql';

async function main(): Promise<void> {
  const parsed = parseCli(process.argv.slice(2));
  jsonRequested = parsed.has('--json');
  graphqlRequested = parsed.command === 'graphql';
  if (parsed.helpText || parsed.displayText) {
    process.stdout.write(parsed.helpText ?? parsed.displayText!);
    return;
  }
  switch (parsed.command) {
    case 'diagnostics': await (await import('./commands/diagnostics.js')).runDiagnostics(parsed); break;
    case 'usage': await (await import('./commands/usage.js')).runUsage(parsed); break;
    case 'graphql': {
      const result = await (await import('./commands/graphql.js')).runGraphQL(parsed);
      writeOutput(JSON.stringify(result, null, 2), true);
      if ((await import('./graphql/results.js')).hasGraphQLProblems(result)) process.exitCode = 1;
      break;
    }
    case 'artifact': {
      const { runArtifact } = await import('./commands/artifact.js');
      writeOutput(await runArtifact(parsed), parsed.has('--json'));
      break;
    }
    case 'show': await (await import('./commands/show.js')).runShow(parsed); break;
    case 'plugin': await (await import('./commands/plugin.js')).runPlugin(parsed); break;
    case 'daemon': await (await import('./commands/daemon.js')).runDaemon(parsed); break;
    case 'instance': process.exitCode = (await (await import('./commands/instance.js')).runInstance(parsed)) ?? 0; break;
    case 'mcp': await (await import('./commands/mcp.js')).runMcp(parsed); break;
  }
}

main().then(() => { if (outputState().failedChecks) process.exitCode = 1; }).catch(async (e: unknown) => {
  if (e instanceof InstancePathError) {
    try { await (await import('./commands/instance-gc.js')).collectAfterFailedUse(); }
    catch { /* Preserve the operation's original error if registry cleanup is unavailable. */ }
  }
  if (graphqlRequested) {
    writeOutput(JSON.stringify({ errors: [{ message: e instanceof Error ? e.message : String(e) }] }, null, 2), true);
    process.exitCode = 1;
    return;
  }
  if (e instanceof CliParseError ? e.jsonRequested : jsonRequested) {
    if (!outputState().jsonWritten) console.log(errorResult(process.argv.slice(2, 4).filter(arg => !arg.startsWith('-')).join(' '), e));
    process.exitCode = 1;
    return;
  }
  console.error(errorLine(e));
  process.exitCode = 1;
});
