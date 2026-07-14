// Web: warm the browser HTTP cache. An <img> element fetch lands in the same
// cache the gallery's <Image source={{uri}}> reads from, so the later render
// is served from disk/memory. Resolves (never rejects) on load or error.
export function prefetchImage(url: string): Promise<boolean> {
  return new Promise(resolve => {
    const img = new window.Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = url;
  });
}
