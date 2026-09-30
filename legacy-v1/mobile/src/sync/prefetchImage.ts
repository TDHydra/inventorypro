// Native: warm the OS image cache so the thumbnail renders with no flash when
// it scrolls into view. Web swaps in prefetchImage.web.ts (Metro platform
// extension, same pattern as netinfo.ts).
import { Image } from 'react-native';

export function prefetchImage(url: string): Promise<boolean> {
  return Image.prefetch(url).catch(() => false);
}
