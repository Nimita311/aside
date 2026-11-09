import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { platform, release } from 'node:os';
import { GEOCODING_HELPER_TIMEOUT_MS, GEOCODING_HELPER_MAX_STDOUT_BYTES, GEOCODING_HELPER_MAX_STDERR_BYTES, GEOCODING_QUEUE_LIMIT } from '../core/system-config.js';
import { nativeCommand } from '../native/helper.js';

export interface GeocodeAddressInput {
  query: string;
  region?: { latitude: number; longitude: number; radiusMeters: number } | null;
}

export interface GeocodeCandidate {
  geo: string;
  latitude: number;
  longitude: number;
  formattedAddress: string | null;
  name: string | null;
  countryCode: string | null;
  mapUrl: string;
}

export interface GeocodeAddressResult {
  status: 'SUCCESS' | 'NO_RESULTS' | 'UNAVAILABLE' | 'FAILED';
  provider: 'APPLE';
  candidates: GeocodeCandidate[];
  error: string | null;
}

export interface GeocodeAddressOptions { signal?: AbortSignal }

export interface GeocoderConfiguration {
  // Overrides support deterministic one-shot helper fixtures without MapKit.
  binPath?: string | null;
  nativeBinary?: string;
  platform?: NodeJS.Platform;
  release?: string;
  timeoutMs?: number;
}

function result(status: GeocodeAddressResult['status'], error: string | null = null, candidates: GeocodeCandidate[] = []): GeocodeAddressResult {
  return { status, provider: 'APPLE', candidates, error };
}

function cancelled(): GeocodeAddressResult {
  return result('FAILED', 'Apple geocoding request was cancelled.');
}

function coordinate(value: unknown, limit: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit;
}

/** Validate before scheduling work; diagnostics never repeat query text. */
export function normalizeGeocodeAddressInput(input: GeocodeAddressInput): GeocodeAddressInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Geocoding requires a query.');
  }
  if (Object.keys(input).some(key => !['query', 'region'].includes(key))) {
    throw new Error('Geocoding accepts query and optional region.');
  }
  const text = input.query;
  if (typeof text !== 'string' || !text.trim() || text.length > 4096 || text.includes('\0')) {
    throw new Error('Geocoding query must be a nonblank string of at most 4096 characters.');
  }
  const normalized: GeocodeAddressInput = { query: text.trim() };
  if (input.region != null) {
    const region = input.region;
    if (typeof region !== 'object' || !coordinate(region.latitude, 90) || !coordinate(region.longitude, 180)
      || typeof region.radiusMeters !== 'number' || !Number.isFinite(region.radiusMeters) || region.radiusMeters <= 0 || region.radiusMeters > 20_000_000) {
      throw new Error('Geocoding region requires valid latitude, longitude, and a radius greater than zero and at most 20000000 meters.');
    }
    normalized.region = { latitude: region.latitude, longitude: region.longitude, radiusMeters: region.radiusMeters };
  }
  return normalized;
}

// RFC 5870 decimal coordinates do not allow JavaScript's exponent notation.
function decimal(value: number): string {
  const text = String(value);
  if (!/[eE]/.test(text)) return text;
  const [coefficient, exponent] = text.toLowerCase().split('e');
  const negative = coefficient.startsWith('-');
  const unsigned = negative ? coefficient.slice(1) : coefficient;
  const digits = unsigned.replace('.', '');
  const point = (unsigned.includes('.') ? unsigned.indexOf('.') : unsigned.length) + Number(exponent);
  const expanded = point <= 0 ? `0.${'0'.repeat(-point)}${digits}`
    : point >= digits.length ? digits + '0'.repeat(point - digits.length)
    : `${digits.slice(0, point)}.${digits.slice(point)}`;
  return `${negative ? '-' : ''}${expanded}`;
}

function optionalText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length > 4096) throw new Error('Invalid native text.');
  return value.trim() || null;
}

function parseResponse(stdout: Buffer): GeocodeAddressResult {
  try {
    const response: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(stdout));
    if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error('Invalid response.');
    const native = response as Record<string, unknown>;
    if (native.status === 'FAILED') {
      // The native helper supplies only NSError domain/code. Accept that exact
      // grammar; never expose arbitrary native error text or stderr.
      const reason = typeof native.error === 'string' && /^Apple geocoding failed \([A-Za-z][A-Za-z0-9._-]{0,127}, code -?\d{1,10}\)\.$/.test(native.error)
        ? native.error : 'Apple geocoding failed.';
      return result('FAILED', `${reason} Retry later, or refine the query and region hint.`);
    }
    if (native.status === 'NO_RESULTS' && (native.candidates === undefined || (Array.isArray(native.candidates) && native.candidates.length === 0))) {
      return result('NO_RESULTS');
    }
    if (native.status !== 'SUCCESS' || !Array.isArray(native.candidates) || native.candidates.length === 0) throw new Error('Invalid response.');
    const candidates = native.candidates.map((candidate: unknown): GeocodeCandidate => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('Invalid candidate.');
      const value = candidate as Record<string, unknown>;
      if (!coordinate(value.latitude, 90) || !coordinate(value.longitude, 180)) throw new Error('Invalid coordinate.');
      const latitude = value.latitude, longitude = value.longitude;
      const point = `${decimal(latitude)},${decimal(longitude)}`;
      const formattedAddress = optionalText(value.formattedAddress), name = optionalText(value.name), countryCode = optionalText(value.countryCode);
      const map = new URL('https://maps.apple.com/place');
      map.searchParams.set('coordinate', point);
      if (formattedAddress) map.searchParams.set('address', formattedAddress);
      if (name) map.searchParams.set('name', name);
      return { geo: `geo:${point}`, latitude, longitude, formattedAddress, name, countryCode, mapUrl: map.href };
    });
    return result('SUCCESS', null, candidates);
  } catch {
    return result('FAILED', 'Apple geocoding helper returned an invalid response.');
  }
}

function runHelper(input: GeocodeAddressInput, options: GeocodeAddressOptions, configuration: GeocoderConfiguration): Promise<GeocodeAddressResult> {
  if (options.signal?.aborted) return Promise.resolve(cancelled());
  const darwinVersion = /^(\d+)(?:\.|$)/.exec(configuration.release ?? release());
  if ((configuration.platform ?? platform()) !== 'darwin' || !darwinVersion || Number(darwinVersion[1]) < 23) {
    return Promise.resolve(result('UNAVAILABLE', 'Apple geocoding requires macOS 14 or later.'));
  }
  const command = nativeCommand('geocode', { legacyPath: configuration.binPath, legacyEnv: 'ASIDE_GEO_BIN', nativePath: configuration.nativeBinary });
  if (!command || !existsSync(command.file)) return Promise.resolve(result('UNAVAILABLE', 'Apple geocoding helper is not installed.'));
  return new Promise(resolve => {
    let child: ReturnType<typeof spawn>;
    try { child = spawn(command.file, command.args, { stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { resolve(result('UNAVAILABLE', 'Apple geocoding helper could not start.')); return; }
    let settled = false, exited = false, stdoutBytes = 0, stderrBytes = 0;
    let terminatingResult: GeocodeAddressResult | undefined;
    const stdout: Buffer[] = [];
    let exitDrain: ReturnType<typeof setTimeout> | undefined;
    const finish = (response: GeocodeAddressResult, terminate = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(exitDrain);
      options.signal?.removeEventListener('abort', abort);
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (terminate && !exited && child.pid !== undefined) {
        // Keep the queue occupied until this helper actually exits, including
        // when a cancelled helper takes the SIGKILL grace period to stop.
        terminatingResult = response;
        child.kill('SIGTERM');
        const force = setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, 100);
        force.unref();
      } else resolve(response);
      stdout.length = 0;
    };
    const abort = () => finish(cancelled(), true);
    const timeout = setTimeout(() => finish(result('FAILED', 'Apple geocoding request timed out. Retry later.'), true), configuration.timeoutMs ?? GEOCODING_HELPER_TIMEOUT_MS);
    options.signal?.addEventListener('abort', abort, { once: true });
    child.on('error', () => finish(result('UNAVAILABLE', 'Apple geocoding helper could not start.'), true));
    child.stdin?.on('error', () => finish(result('FAILED', 'Apple geocoding helper communication failed.'), true));
    child.stdout?.on('error', () => finish(result('FAILED', 'Apple geocoding helper communication failed.'), true));
    child.stderr?.on('error', () => finish(result('FAILED', 'Apple geocoding helper communication failed.'), true));
    child.stdout?.on('data', (data: Buffer) => {
      if (settled) return;
      stdoutBytes += data.length;
      if (stdoutBytes > GEOCODING_HELPER_MAX_STDOUT_BYTES) finish(result('FAILED', 'Apple geocoding helper exceeded its output limit.'), true);
      else stdout.push(data);
    });
    // Stderr is discarded rather than logged: native diagnostics can echo input.
    child.stderr?.on('data', (data: Buffer) => {
      if (settled) return;
      stderrBytes += data.length;
      if (stderrBytes > GEOCODING_HELPER_MAX_STDERR_BYTES) finish(result('FAILED', 'Apple geocoding helper exceeded its output limit.'), true);
    });
    child.on('exit', (code, signal) => {
      exited = true;
      if (settled) { if (terminatingResult) resolve(terminatingResult); return; }
      if (code !== 0 || signal) finish(result('FAILED', 'Apple geocoding helper exited unexpectedly.'));
      // An inherited pipe must not keep an exited helper's request pending.
      else exitDrain = setTimeout(() => finish(result('FAILED', 'Apple geocoding helper did not close its response.')), 100);
    });
    child.on('close', (code, signal) => {
      if (terminatingResult) { exited = true; resolve(terminatingResult); }
      if (!settled) finish(code === 0 && !signal ? parseResponse(Buffer.concat(stdout, stdoutBytes)) : result('FAILED', 'Apple geocoding helper exited unexpectedly.'));
    });
    if (options.signal?.aborted) abort();
    else child.stdin?.end(`${JSON.stringify(input)}\n`);
  });
}

/** Each client serializes native lookups; cancelling queued work never spawns it. */
export function createGeocoder(configuration: GeocoderConfiguration = {}): (input: GeocodeAddressInput, options?: GeocodeAddressOptions) => Promise<GeocodeAddressResult> {
  interface Job { input: GeocodeAddressInput; options: GeocodeAddressOptions; resolve: (value: GeocodeAddressResult) => void; abort: () => void }
  const queue: Job[] = [];
  let running = false;
  const pump = () => {
    if (running) return;
    const job = queue.shift();
    if (!job) return;
    job.options.signal?.removeEventListener('abort', job.abort);
    running = true;
    void runHelper(job.input, job.options, configuration).then(job.resolve, () => job.resolve(result('FAILED', 'Apple geocoding failed.'))).finally(() => {
      running = false;
      pump();
    });
  };
  return async (input, options = {}) => {
    const normalized = normalizeGeocodeAddressInput(input);
    if (options.signal?.aborted) return cancelled();
    if (queue.length >= GEOCODING_QUEUE_LIMIT) return result('FAILED', 'Apple geocoding queue is full. Retry after the pending lookups finish.');
    return new Promise(resolve => {
      const job: Job = { input: normalized, options: { signal: options.signal }, resolve, abort: () => {
        const index = queue.indexOf(job);
        if (index < 0) return;
        queue.splice(index, 1);
        resolve(cancelled());
      } };
      queue.push(job);
      options.signal?.addEventListener('abort', job.abort, { once: true });
      pump();
    });
  };
}

// One shared queue bounds alias-heavy GraphQL requests to one native lookup.
export const geocodeAddress = createGeocoder();
