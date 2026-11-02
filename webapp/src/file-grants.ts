import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  buildFileGrantUrl, fileGrantBase64, fileGrantKeyBytes, fileGrantMessage, fileGrantScope,
} from '../../cli/src/core/web-file-grant';

/** Sign URLs synchronously without exposing the instance key to media or frames. */
export function grantUrl(fileBase: string, fileKey: string, path: string): string {
  const scope = fileGrantScope(path);
  const signature = fileGrantBase64(hmac(sha256, fileGrantKeyBytes(fileKey), new TextEncoder().encode(fileGrantMessage(scope))));
  return buildFileGrantUrl(fileBase, scope, signature, path);
}
