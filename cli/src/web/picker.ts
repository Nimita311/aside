import {execFile} from 'node:child_process';
import {nativeCommand} from '../native/helper.js';

export type PickerKind = 'directory' | 'manifest';
export type InstanceRegistration = { kind: PickerKind } | { path: string };
export function pickInstance(kind: PickerKind): Promise<string | null> {
  if (process.platform !== 'darwin') throw new Error('The native picker is available on macOS. Register an existing instance with aside instance add --dir <path>.');
  const command = nativeCommand('pick-instance');
  if (!command) throw new Error('The native instance picker is unavailable. Rebuild the CLI.');
  return new Promise((resolve, reject) => {
    execFile(command.file, [...command.args, kind], {maxBuffer: 64 * 1024}, (error, stdout, stderr) => {
      if (!error) resolve(stdout.replace(/\n$/, '') || null);
      else reject(new Error(`Could not open the native picker: ${stderr.trim() || error.message}`));
    });
  });
}
