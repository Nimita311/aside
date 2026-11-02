import { resolve } from 'node:path';
import { parseCommand, type CommandInput } from './options.js';
import { validate } from '../core/validator.js';
import { publishReport } from './output.js';

export function runValidate(args: CommandInput): number {
  const options = parseCommand('instance', Array.isArray(args) ? ['validate', ...args] : args);
  if (options.helpText) { console.log(options.helpText); return 0; }
  const directory = resolve(options.get('--dir') ?? '.');
  const result = validate(directory);
  publishReport({ title: result.dataChecksRun ? 'Aside validation' : 'Aside validation blocked', data: { directory, ...result },
    sections: [{ name: 'Information', fields: { Directory: directory,
      ...(result.dataChecksRun ? { Checks: result.checks.length, 'Failed checks': result.checks.filter(check => !check.passed).length }
        : { Result: 'Cannot validate this directory. Data checks were not run.' }) } }],
    checks: result.checks.map((check) => ({ code: `validation_${check.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`, label: check.name, passed: check.passed,
      ...(!check.passed ? { problems: check.details ?? [] } : {}),
      ...(!result.dataChecksRun ? { fixes: ['Run aside instance validate --dir <instance-directory> with a readable aside.md manifest.'] } : {}) })),
  }, 'instance validate', options.has('--json'));
  return result.passed ? 0 : 1;
}
