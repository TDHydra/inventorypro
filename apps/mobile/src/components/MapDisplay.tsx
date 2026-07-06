import { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';
import { radii } from '../theme';
import { LEAFLET_JS, LEAFLET_CSS, MARKER_ICON, MARKER_ICON_2X, MARKER_SHADOW } from './leafletAssets';

interface Props {
  latitude: number;
  longitude: number;
  radiusMiles?: number;   // map extent (region shown around the pin)
  showRadius?: boolean;   // draw the radius circle (off for point-of-interest views)
  height?: number;
}

// View-only Leaflet + OpenStreetMap display rendered in a WebView. Free (no API
// key / billing). Leaflet 1.9.4 JS/CSS + the default marker icons are VENDORED
// and injected INLINE (see leafletAssets.ts) — nothing loads from a CDN; only the
// OpenStreetMap tile layer is fetched online. Drops a marker at [lat,lng] and fits
// the view to a radiusMiles extent (optionally drawing the circle). No tap handler,
// no postMessage.
function buildHtml(latitude: number, longitude: number, radiusMeters: number, showRadius: boolean): string {
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return '<html></html>';
  return `<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
<style>${LEAFLET_CSS}</style>
<style>
  html,body,#map{height:100%;margin:0;padding:0;background:#E2E8F0}
</style></head><body>
<div id="map"></div>
<script>${LEAFLET_JS}</script>
<script>
  // Point the default marker icon at the inlined data-URI assets (no CDN / relative fetch).
  delete L.Icon.Default.prototype._getIconUrl;
  L.Icon.Default.mergeOptions({
    iconUrl: '${MARKER_ICON}', iconRetinaUrl: '${MARKER_ICON_2X}', shadowUrl: '${MARKER_SHADOW}'
  });
  var map = L.map('map', { zoomControl: false, attributionControl: false }).setView([${lat}, ${lng}], 10);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© OpenStreetMap'
  }).addTo(map);
  L.marker([${lat}, ${lng}]).addTo(map);
  // Circle is used to compute the extent; only shown when showRadius.
  var circle = L.circle([${lat}, ${lng}], {
    radius: ${radiusMeters}, color: '#2563EB', fillColor: '#2563EB', fillOpacity: 0.12, weight: 2
  });
  if (${showRadius ? 'true' : 'false'}) circle.addTo(map);
  map.fitBounds(circle.getBounds());
</script></body></html>`;
}

export function MapDisplay({ latitude, longitude, radiusMiles = 35, showRadius = false, height = 220 }: Props) {
  const html = useMemo(
    () => buildHtml(latitude, longitude, radiusMiles * 1609.34, showRadius),
    [latitude, longitude, radiusMiles, showRadius],
  );

  return (
    <View style={[s.wrap, { height }]}>
      <WebView
        originWhitelist={['https://*.openstreetmap.org', 'about:blank']}
        javaScriptEnabled
        scrollEnabled={false}
        setSupportMultipleWindows={false}
        source={{ html }}
        style={{ flex: 1 }}
      />
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    borderRadius: radii.lg,
    overflow: 'hidden',
    backgroundColor: '#E2E8F0',
  },
});
