function canvasFor(width: number, height: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Image encoding failed'))), type, quality),
  );
}

export function imageToPng(image: ImageData): Promise<Blob> {
  const c = canvasFor(image.width, image.height);
  c.getContext('2d')!.putImageData(image, 0, 0);
  return toBlob(c, 'image/png');
}

/** Small JPEG for the gallery. */
export async function imageToThumbnail(image: ImageData, maxSide = 360): Promise<Blob> {
  const full = canvasFor(image.width, image.height);
  full.getContext('2d')!.putImageData(image, 0, 0);
  const s = Math.min(1, maxSide / Math.max(image.width, image.height));
  const t = canvasFor(Math.max(1, Math.round(image.width * s)), Math.max(1, Math.round(image.height * s)));
  const ctx = t.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(full, 0, 0, t.width, t.height);
  return toBlob(t, 'image/jpeg', 0.85);
}

/** Share via the system share sheet where possible, otherwise download. */
export async function shareOrDownload(blob: Blob, filename: string): Promise<'shared' | 'downloaded'> {
  const file = new File([blob], filename, { type: blob.type });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.share && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: filename });
      return 'shared';
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return 'shared';
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return 'downloaded';
}
