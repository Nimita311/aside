import {lstatSync, readdirSync, realpathSync} from 'node:fs';
import {dirname, join, relative, resolve, sep} from 'node:path';
import {artifactAttachmentPath, artifactHandle, isArtifactStagingFilename, isInside} from './artifact.js';

export interface AttachmentFile {
  filename: string;
  handle?: string;
  path?: string;
  error?: string;
}

/** Source-owner capture. Queries consume the published result without I/O. */
export function readAttachmentFiles(dataDir: string, id: string, filenames: readonly string[]): AttachmentFile[] {
  return filenames.map(filename => {
    const result: AttachmentFile = {filename};
    try {
      result.handle = artifactHandle(id, filename);
      if (isArtifactStagingFilename(filename)) throw new Error('reserved staging file');
      const root = realpathSync(dataDir);
      const file = artifactAttachmentPath(root, id, filename);
      const directory = dirname(file);
      let component = root;
      for (const segment of relative(root, directory).split(sep)) {
        component = join(component, segment);
        if (!lstatSync(component).isDirectory()) throw new Error('managed attachment directory must be an ordinary directory');
      }
      if (!lstatSync(file).isFile()) throw new Error('attachment must be an ordinary regular file');
      const savedDirectory = realpathSync(directory);
      const savedFile = realpathSync(file);
      if (!isInside(root, savedDirectory) || !isInside(savedDirectory, savedFile)) throw new Error('attachment is outside its managed directory or instance');
      if (!readdirSync(directory).includes(filename)) throw new Error('exact indexed filename is missing');
      result.path = savedFile;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const reason = code === 'ENOENT' ? 'indexed attachment is missing' : error instanceof Error ? error.message : String(error);
      result.error = `${reason}. Run Aside validate and repair or reimport the attachment through MCP.`;
    }
    return result;
  });
}

/** Capture aliases with the source generation instead of resolving them in queries. */
export function readReferenceRoots(root: string): readonly string[] {
  return [...new Set([resolve(root), realpathSync(root)])];
}
