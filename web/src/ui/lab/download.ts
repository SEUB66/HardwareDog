import { safeFileName } from '../../core/flipper/library';

/** Save bytes as a local file, under a safe name (no path, no control characters). */
export function download(name: string, type: string, content: BlobPart) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = safeFileName(name);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
