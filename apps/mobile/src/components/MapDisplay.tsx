import { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';
import { radii } from '../theme';

interface Props {
  latitude: number;
  longitude: number;
  radiusMiles?: number;   // map extent (region shown around the pin)
  showRadius?: boolean;   // draw the radius circle (off for point-of-interest views)
  height?: number;
}

// View-only Leaflet + OpenStreetMap display rendered in a WebView. Free (no API
// key / billing). ONLINE-ONLY — tiles + Leaflet load from CDN. Drops a marker at
// [lat,lng] and fits the view to a radiusMiles extent (optionally drawing the
// circle). No tap handler, no postMessage.
function buildHtml(lat: number, lng: number, radiusMeters: number, showRadius: boolean): string {
  return `<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
  html,body,#map{height:100%;margin:0;padding:0;background:#E2E8F0}
</style></head><body>
<div id="map"></div>
<script>
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
        originWhitelist={['*']}
        javaScriptEnabled
        scrollEnabled={false}
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
