import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { GraphQLError } from 'graphql';
import { resolvePrompt } from '../automation/execution.js';
import { artifactContentFilename, artifactHandle } from '../core/artifact.js';
import { contentAttachmentPath } from '../core/content-attachment.js';
import { AUTOMATION_PROMPT_MAX_BYTES } from '../core/system-config.js';
import { prepareCreateArtifact, type PreparedArtifactCreate } from '../mcp/tools/artifact.js';
import type { Store } from '../mcp/store.js';
import { authoredAutomationPrompts } from './inputs.js';

function inlinePrompt(plan: PreparedArtifactCreate): string {
  if (!plan.contentFile) return plan.artifact.body;
  const fd = openSync(plan.contentFile, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > AUTOMATION_PROMPT_MAX_BYTES) throw new Error(`Prompt attachment must be a regular UTF-8 file of at most ${AUTOMATION_PROMPT_MAX_BYTES} bytes.`);
    return new TextDecoder('utf8', {fatal: true}).decode(readFileSync(fd));
  } finally {closeSync(fd);}
}

/** Preflight all prompt references and creates before the owner can write. */
export function prepareAutomationPrompts(store: Store, args: Record<string, any>): (() => void) | undefined {
  const requests = authoredAutomationPrompts(args);
  if (!requests.length) return;
  const plans = new Map<string, PreparedArtifactCreate>();
  try {
    for (const request of requests) {
      if (!request.create) continue;
      if (plans.has(request.id)) throw new Error(`Two new prompt artifacts derive the same ID "${request.id}". Choose different names.`);
      const plan = prepareCreateArtifact(store, request.create, request.now);
      plans.set(plan.id, plan);
    }
    for (const request of requests) {
      const plan = plans.get(request.id);
      const artifact = plan ? undefined : store.getArtifact(request.id);
      if (!plan && !artifact) throw new Error(`Prompt artifact "${request.id}" not found. Query artifacts for its exact ID, or provide prompt.create.`);
      if (artifact) {
        const filename = artifactContentFilename(artifact);
        if (filename !== undefined) contentAttachmentPath(store.getDataDir(), request.id, filename);
      }
      const content = plan ? inlinePrompt(plan) : resolvePrompt(store.getDataDir(), artifactHandle(request.id));
      if (!content.trim()) throw new Error(`Prompt artifact "${request.id}" has empty primary content. Add instructions to its body or its single primary text attachment.`);
      if (Buffer.byteLength(content) > AUTOMATION_PROMPT_MAX_BYTES) throw new Error(`Prompt artifact "${request.id}" exceeds the ${AUTOMATION_PROMPT_MAX_BYTES}-byte prompt limit.`);
    }
  } catch (error) {
    throw new GraphQLError(`Invalid automation prompt: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!plans.size) return;
  let committed = false;
  return () => {
    if (committed) return;
    committed = true;
    for (const plan of plans.values()) plan.commit();
  };
}
