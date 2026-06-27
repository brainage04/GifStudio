import { access } from 'node:fs/promises';
import path from 'node:path';

export const baseGifAsset = ['assets', 'base', 'woman_is_talking.gif'] as const;
export const defaultOverlayAsset = ['assets', 'overlays', 'brainage.jpg'] as const;

export const findStaticAsset = async (...segments: string[]): Promise<string> => {
  const candidates = [
    path.join(process.cwd(), 'public', ...segments),
    path.join(process.cwd(), 'dist', 'client', ...segments),
    path.join(process.cwd(), 'client', ...segments),
  ];

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next build/runtime layout.
    }
  }

  throw new Error(`Static asset not found: /${segments.join('/')}`);
};
