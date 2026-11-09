import { parse as parseYaml } from 'yaml';

// Quote a scalar string for safe inline YAML. A value stays bare only when it
// has none of the characters that could change the parse (colons, brackets,
// leading indicators, surrounding whitespace, newlines) AND parses back as the
// identical string — which catches YAML-typed scalars (`null`, `true`, `007`,
// `1e3`, the empty string) that would otherwise round-trip as non-strings.
// Everything else is double-quoted with escapes.
export function yamlQuote(value: string): string {
  if (!/[:#\[\]{}&*!|>'"%@`\n\r]/.test(value) && !/^[-?,]/.test(value) && value === value.trim()) {
    try {
      if (parseYaml(value) === value) return value;
    } catch {}
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
}
