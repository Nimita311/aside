import { validate } from '../../core/validator.js';
import { formatScalar } from '../format.js';

export function handleValidate(dataDir: string): string {
  const result = validate(dataDir);
  const lines: string[] = result.dataChecksRun ? [] : ['Cannot validate this directory. Data checks were not run.', ''];
  for (const check of result.checks) {
    const status = check.passed ? 'PASS' : 'FAIL';
    lines.push(`${status}  ${check.name}`);
    if (!check.passed && check.details) {
      for (const d of check.details) {
        lines.push(`      - ${formatScalar(d)}`);
      }
    }
  }
  const passed = result.checks.filter(c => c.passed).length;
  if (result.dataChecksRun) lines.push('', `${passed} of ${result.checks.length} checks passed`);
  return lines.join('\n');
}
