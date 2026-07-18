import { ScrollViewStyleReset } from 'expo-router/html';
import type { PropsWithChildren } from 'react';

/**
 * Web-only HTML shell (expo-router static rendering). Two theme jobs:
 * - Preload the theme faces (Nunito for Fluid, Rajdhani for Futuristic) so
 *   switching to those themes doesn't flash unstyled text.
 * - Neutral color-scheme + scrollbar handling: the JS theme store owns colors,
 *   but dark themes (Futuristic) want dark scrollbars/form controls — the boot
 *   script below applies the cached choice before first paint (no light flash).
 */
export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no" />
        <ScrollViewStyleReset />
        {/* Dark themes get a dark color-scheme before React mounts. The theme
            store mirrors theme.dark into localStorage on web (see themes/store). */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{document.documentElement.style.colorScheme=localStorage.getItem('inventorypro_theme_dark')==='1'?'dark':'light';}catch(e){}`,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
