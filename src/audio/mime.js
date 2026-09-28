'use strict';
// Content-Type of an audio payload: extension first, magic bytes as a fallback for
// extensionless downloads (an object URL or a signed link often has no suffix).
//
// Ф0 is audio-only on purpose (T9 / challenge A): ffmpeg does not live in a small
// domain repo, and video decoding stays in core's video_analyze_batch. A video
// container is detected by EXTENSION — deterministic and testable, no magic-byte
// guessing that would misclassify an .m4a inside an .mp4 name.

const path = require('path');

const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.mov', '.avi', '.wmv', '.flv', '.m4v', '.mpeg', '.mpg']);

const AUDIO_BY_EXT = {
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.spx': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav', '.wave': 'audio/wav',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4', '.mp4a': 'audio/mp4', '.aac': 'audio/aac',
  '.webm': 'audio/webm', '.weba': 'audio/webm',
  '.amr': 'audio/amr',
  '.aiff': 'audio/aiff', '.aif': 'audio/aiff',
  '.wma': 'audio/x-ms-wma',
};

const VIDEO_HINT =
  'Скил распознаёт только аудио. Передай аудиофайл; видео декодирует video_analyze_batch (ядро, ffmpeg -vn).';

function extOf(p) {
  // A URL may carry a query — the extension lives in the pathname.
  let s = String(p || '');
  try { if (/^https?:\/\//i.test(s)) s = new URL(s).pathname; } catch { /* keep as-is */ }
  return path.extname(s).toLowerCase();
}

function isVideoContainer(p) {
  return VIDEO_EXTS.has(extOf(p));
}

function magicContentType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg';
  if (buf.toString('ascii', 0, 4) === 'fLaC') return 'audio/flac';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WAVE') return 'audio/wav';
  if (buf.toString('ascii', 0, 3) === 'ID3') return 'audio/mpeg';
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  return null;
}

// Content-Type for Deepgram, or null when the file type is not recognised.
function contentTypeFor(filePath, buf) {
  const byExt = AUDIO_BY_EXT[extOf(filePath)];
  if (byExt) return byExt;
  return magicContentType(buf);
}

module.exports = { VIDEO_EXTS, AUDIO_BY_EXT, VIDEO_HINT, extOf, isVideoContainer, contentTypeFor, magicContentType };
