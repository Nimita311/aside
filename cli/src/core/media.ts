// The media files Aside embeds rather than renders as text, by extension: the
// MIME type the web server sends and the kind the reader embeds them as. One
// table, so the server and the browser can never disagree about a file.
export type MediaKind = 'image' | 'pdf' | 'audio' | 'video';

export const MEDIA_TYPES: Record<string, { kind: MediaKind; mime: string }> = {
  svg: { kind: 'image', mime: 'image/svg+xml' },
  png: { kind: 'image', mime: 'image/png' },
  jpg: { kind: 'image', mime: 'image/jpeg' },
  jpeg: { kind: 'image', mime: 'image/jpeg' },
  gif: { kind: 'image', mime: 'image/gif' },
  webp: { kind: 'image', mime: 'image/webp' },
  avif: { kind: 'image', mime: 'image/avif' },
  bmp: { kind: 'image', mime: 'image/bmp' },
  ico: { kind: 'image', mime: 'image/vnd.microsoft.icon' },
  pdf: { kind: 'pdf', mime: 'application/pdf' },
  mp4: { kind: 'video', mime: 'video/mp4' },
  m4v: { kind: 'video', mime: 'video/mp4' },
  webm: { kind: 'video', mime: 'video/webm' },
  mov: { kind: 'video', mime: 'video/quicktime' },
  ogv: { kind: 'video', mime: 'video/ogg' },
  mp3: { kind: 'audio', mime: 'audio/mpeg' },
  wav: { kind: 'audio', mime: 'audio/wav' },
  ogg: { kind: 'audio', mime: 'audio/ogg' },
  oga: { kind: 'audio', mime: 'audio/ogg' },
  m4a: { kind: 'audio', mime: 'audio/mp4' },
  flac: { kind: 'audio', mime: 'audio/flac' },
  aac: { kind: 'audio', mime: 'audio/aac' },
  opus: { kind: 'audio', mime: 'audio/ogg' },
  weba: { kind: 'audio', mime: 'audio/webm' },
};
