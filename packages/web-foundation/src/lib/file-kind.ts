const INLINE_IMAGE_EXTENSIONS = new Set(['.avif', '.jpeg', '.jpg', '.png', '.webp']);
const INLINE_IMAGE_MEDIA_TYPES = new Set(['image/avif', 'image/jpeg', 'image/png', 'image/webp']);
const INLINE_IMAGE_BYTE_CEILING = 10 * 1024 * 1024;

const IMAGE_MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

function fileExtension(file: File): string {
  const name = file.name.toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot);
}

export function isImageFile(file: File): boolean {
  if (file.size > INLINE_IMAGE_BYTE_CEILING) return false;

  const mediaType = file.type.trim().toLowerCase();
  return mediaType === '' || mediaType === 'application/octet-stream'
    ? INLINE_IMAGE_EXTENSIONS.has(fileExtension(file))
    : INLINE_IMAGE_MEDIA_TYPES.has(mediaType);
}

export function mediaTypeForFile(file: File): string {
  const inferred = IMAGE_MEDIA_TYPES[fileExtension(file)];
  if (inferred !== undefined && (file.type === '' || file.type === 'application/octet-stream')) {
    return inferred;
  }
  return file.type === '' ? 'application/octet-stream' : file.type;
}
