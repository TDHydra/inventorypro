import { useMemo } from 'react';
import { View, Text, Modal, TouchableOpacity, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import type { Theme } from '../themes/types';
import { useThemedStyles } from '../hooks/useThemedStyles';
import { LEAFLET_JS, LEAFLET_CSS, MARKER_ICON, MARKER_ICON_2X, MARKER_SHADOW } from './leafletAssets';

export interface PickedCoords {
  latitude: number;
  longitude: number;
}

interface Props {
  visible: boolean;
  initial?: PickedCoords | null;
  onPick: (coords: PickedCoords) => void;
  onClose: () => void;
}

// Leaflet + OpenStreetMap tap-to-set picker rendered in a WebView. Free (no API
// key / billing). Leaflet 1.9.4 JS/CSS + the default marker icons are VENDORED and
// injected INLINE (see leafletAssets.ts) — nothing loads from a CDN; only the
// OpenStreetMap tile layer is fetched online (manual + current modes cover offline).
// The page posts the chosen {latitude,longitude} back via
// window.ReactNativeWebView.postMessage; RN reads it in onMessage.
function buildHtml(initial: PickedCoords | null | undefined, bottomInset: number): string {
  // Coords are numbers (validated upstream); default to a neutral world view.
  const lat = typeof initial?.latitude === 'number' ? initial.latitude : 39.5;
  const lng = typeof initial?.longitude === 'number' ? initial.longitude : -98.35;
  const zoom = initial ? 16 : 4;
  // Edge-to-edge: this button is CSS position:absolute/bottom (fixed) inside the
  // WebView's HTML, so the transparent gesture/3-button nav bar can overlay it
  // unless the safe-area inset (passed in from RN) is folded into the offset
  // (same class of bug as ScanReceipt's Add more / Done bar, #163).
  return `<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
<style>${LEAFLET_CSS}</style>
<style>
  html,body,#map{height:100%;margin:0;padding:0}
  #use{position:absolute;left:12px;right:12px;bottom:${16 + bottomInset}px;z-index:1000;background:#2563EB;color:#fff;
       border:none;border-radius:10px;padding:14px;font-size:16px;font-weight:600}
  #use:disabled{background:#94A3B8}
  #hint{position:absolute;left:12px;right:12px;top:12px;z-index:1000;background:rgba(0,0,0,0.6);color:#fff;
        border-radius:8px;padding:8px 10px;font-size:13px;text-align:center}
</style></head><body>
<div id="map"></div>
<div id="hint">Tap the map or drag the pin, then "Use this location"</div>
<button id="use">Use this location</button>
<script>${LEAFLET_JS}</script>
<script>
  // Point the default marker icon at the inlined data-URI assets (no CDN / relative fetch).
  delete L.Icon.Default.prototype._getIconUrl;
  L.Icon.Default.mergeOptions({
    iconUrl: '${MARKER_ICON}', iconRetinaUrl: '${MARKER_ICON_2X}', shadowUrl: '${MARKER_SHADOW}'
  });
  var sel = { latitude: ${lat}, longitude: ${lng} };
  var hasInitial = ${initial ? 'true' : 'false'};
  var useBtn = document.getElementById('use');
  // Without an initial pin, require an explicit tap/drag before the button works
  // (so we never post the default map centre the user never chose).
  useBtn.disabled = !hasInitial;
  var map = L.map('map').setView([${lat}, ${lng}], ${zoom});
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© OpenStreetMap'
  }).addTo(map);
  var marker = L.marker([${lat}, ${lng}], { draggable: true });
  if (hasInitial) marker.addTo(map);
  function set(latlng){ sel = { latitude: latlng.lat, longitude: latlng.lng }; if(!map.hasLayer(marker)) marker.addTo(map); marker.setLatLng(latlng); useBtn.disabled = false; }
  map.on('click', function(e){ set(e.latlng); });
  marker.on('dragend', function(){ set(marker.getLatLng()); });
  document.getElementById('use').addEventListener('click', function(){
    window.ReactNativeWebView.postMessage(JSON.stringify(sel));
  });
</script></body></html>`;
}

export function MapPickerModal({ visible, initial, onPick, onClose }: Props) {
  const s = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const html = useMemo(
    () => buildHtml(initial, insets.bottom),
    [initial?.latitude, initial?.longitude, insets.bottom],
  );

  function handleMessage(e: WebViewMessageEvent) {
    try {
      const data = JSON.parse(e.nativeEvent.data) as PickedCoords;
      if (typeof data.latitude === 'number' && typeof data.longitude === 'number') {
        onPick({ latitude: data.latitude, longitude: data.longitude });
        onClose();
      }
    } catch {
      /* ignore malformed messages */
    }
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={s.header}>
        <Text style={s.title}>Pick location on map</Text>
        <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Text style={s.close}>✕</Text>
        </TouchableOpacity>
      </View>
      {visible && (
        <WebView
          originWhitelist={['https://*.openstreetmap.org', 'about:blank']}
          javaScriptEnabled
          setSupportMultipleWindows={false}
          source={{ html }}
          onMessage={handleMessage}
          style={{ flex: 1 }}
        />
      )}
    </Modal>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: t.spacing.lg,
    paddingVertical: t.spacing.md,
    backgroundColor: t.colors.background,
    borderBottomWidth: 1,
    borderBottomColor: t.colors.textDisabled,
  },
  title: { fontSize: t.typography.fontSizes.lg, fontWeight: '700', color: t.colors.textPrimary },
  close: { fontSize: 22, color: t.colors.textSecondary, paddingHorizontal: t.spacing.sm },
});
