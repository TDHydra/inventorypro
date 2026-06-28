import { useMemo } from 'react';
import { View, Text, Modal, TouchableOpacity, StyleSheet } from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import { colors, spacing, radii, fontSizes } from '../theme';

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
// key / billing). ONLINE-ONLY — tiles + Leaflet load from CDN; manual + current
// modes cover offline. The page posts the chosen {latitude,longitude} back via
// window.ReactNativeWebView.postMessage; RN reads it in onMessage.
function buildHtml(initial?: PickedCoords | null): string {
  // Coords are numbers (validated upstream); default to a neutral world view.
  const lat = typeof initial?.latitude === 'number' ? initial.latitude : 39.5;
  const lng = typeof initial?.longitude === 'number' ? initial.longitude : -98.35;
  const zoom = initial ? 16 : 4;
  return `<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
  html,body,#map{height:100%;margin:0;padding:0}
  #use{position:absolute;left:12px;right:12px;bottom:16px;z-index:1000;background:#2563EB;color:#fff;
       border:none;border-radius:10px;padding:14px;font-size:16px;font-weight:600}
  #use:disabled{background:#94A3B8}
  #hint{position:absolute;left:12px;right:12px;top:12px;z-index:1000;background:rgba(0,0,0,0.6);color:#fff;
        border-radius:8px;padding:8px 10px;font-size:13px;text-align:center}
</style></head><body>
<div id="map"></div>
<div id="hint">Tap the map or drag the pin, then "Use this location"</div>
<button id="use">Use this location</button>
<script>
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
  const html = useMemo(() => buildHtml(initial), [initial?.latitude, initial?.longitude]);

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
          originWhitelist={['*']}
          javaScriptEnabled
          source={{ html }}
          onMessage={handleMessage}
          style={{ flex: 1 }}
        />
      )}
    </Modal>
  );
}

const s = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.background,
    borderBottomWidth: 1,
    borderBottomColor: colors.textDisabled,
  },
  title: { fontSize: fontSizes.lg, fontWeight: '700', color: colors.textPrimary },
  close: { fontSize: 22, color: colors.textSecondary, paddingHorizontal: spacing.sm },
});
