import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface NativeCommand {
  file: string;
  args: string[];
}

export interface NativeCommandOptions {
  /** A per-mode stand-in: runs without a subcommand; null disables the mode. */
  legacyPath?: string | null;
  /** Name of an existing per-mode stand-in environment variable. */
  legacyEnv?: string;
  /** An injected unified executable, such as one passed into a worker. */
  nativePath?: string;
}

/** Resolve the unified executable in source execution and bundled entrypoints. */
export function nativeBinPath(): string {
  if (process.env.ASIDE_NATIVE_BIN) return process.env.ASIDE_NATIVE_BIN;
  const modulePath = fileURLToPath(import.meta.url);
  const directory = dirname(modulePath);
  return /[\\/]src[\\/]native[\\/]helper\.[cm]?[jt]s$/.test(modulePath)
    ? join(directory, '..', '..', 'dist', 'aside-native')
    : join(directory, 'aside-native');
}

/**
 * Explicit per-mode path (including null) > per-mode environment override >
 * injected unified path > ASIDE_NATIVE_BIN > bundled unified executable.
 * Existing stand-ins receive no extra arguments; unified executables receive
 * the mode as their first argument. Consumers own availability diagnostics.
 */
export function nativeCommand(mode: string, options: NativeCommandOptions = {}): NativeCommand | null {
  if (options.legacyPath !== undefined) return options.legacyPath === null ? null : { file: options.legacyPath, args: [] };
  const legacy = options.legacyEnv && process.env[options.legacyEnv];
  if (legacy) return { file: legacy, args: [] };
  return { file: options.nativePath ?? nativeBinPath(), args: [mode] };
}
