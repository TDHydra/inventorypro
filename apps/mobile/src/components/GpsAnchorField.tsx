import { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useCurrentPosition } from '../hooks/useCurrentPosition';
import { MapPickerModal, PickedCoords } from './MapPickerModal';
import { AppInput } from './ui/AppInput';
import { colors, spacing, radii, fontSizes } from '../theme';

interface Props {
  value: PickedCoords | null;
  onChange: (v: PickedCoords | null) => void;
  disabled?: boolean;
}

function inRange(lat: number, lng: number): boolean {
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

// Shared GPS anchor field with three input modes: current position (expo-location),
// manual lat/lng entry, and a map tap-to-set picker (Leaflet/OSM WebView). Used by
// both the location create and edit screens. Honors a maintenance `disabled` lock.
export function GpsAnchorField({ value, onChange, disabled }: Props) {
  const { coords, status, request } = useCurrentPosition();
  const [mapOpen, setMapOpen] = useState(false);
  const [latText, setLatText] = useState(value ? String(value.latitude) : '');
  const [lngText, setLngText] = useState(value ? String(value.longitude) : '');

  // Reflect a current-position capture into the field.
  useEffect(() => {
    if (coords !== null) {
      onChange({ latitude: coords.latitude, longitude: coords.longitude });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coords]);

  // Keep the manual inputs in sync when the value changes from another mode.
  useEffect(() => {
    setLatText(value ? String(value.latitude) : '');
    setLngText(value ? String(value.longitude) : '');
  }, [value?.latitude, value?.longitude]);

  function commitManual(nextLat: string, nextLng: string) {
    const lat = parseFloat(nextLat);
    const lng = parseFloat(nextLng);
    if (!isNaN(lat) && !isNaN(lng) && inRange(lat, lng)) {
      onChange({ latitude: lat, longitude: lng });
    }
  }

  const set = value !== null;
  const manualInvalid =
    (latText.trim() !== '' || lngText.trim() !== '') &&
    !(
      !isNaN(parseFloat(latText)) &&
      !isNaN(parseFloat(lngText)) &&
      inRange(parseFloat(latText), parseFloat(lngText))
    );

  return (
    <View>
      {/* Current position */}
      {status === 'denied' ? (
        <Text style={s.denied}>Location permission off — use manual or map entry, or save without it.</Text>
      ) : (
        <TouchableOpacity
          style={[s.btn, set && s.btnSet]}
          onPress={request}
          disabled={disabled || status === 'loading'}
          activeOpacity={0.7}
        >
          <Text style={[s.btnText, set && s.btnTextSet]}>
            {status === 'loading' ? '📍 Getting location…' : '📍 Use my current spot'}
          </Text>
        </TouchableOpacity>
      )}

      {/* Map picker */}
      <TouchableOpacity
        style={[s.btn, { marginTop: spacing.sm }]}
        onPress={() => setMapOpen(true)}
        disabled={disabled}
        activeOpacity={0.7}
      >
        <Text style={s.btnText}>🗺️ Pick on map</Text>
      </TouchableOpacity>

      {/* Manual entry */}
      <View style={s.manualRow}>
        <AppInput
          style={s.manualInput}
          placeholder="Latitude"
          keyboardType="numbers-and-punctuation"
          value={latText}
          editable={!disabled}
          onChangeText={(t) => { setLatText(t); commitManual(t, lngText); }}
        />
        <AppInput
          style={s.manualInput}
          placeholder="Longitude"
          keyboardType="numbers-and-punctuation"
          value={lngText}
          editable={!disabled}
          onChangeText={(t) => { setLngText(t); commitManual(latText, t); }}
        />
      </View>
      {manualInvalid && <Text style={s.invalid}>Enter a valid latitude (−90..90) and longitude (−180..180).</Text>}

      {/* Resolved value + clear */}
      {set ? (
        <View style={s.resolvedRow}>
          <Text style={s.resolved}>
            ✓ {value!.latitude.toFixed(5)}, {value!.longitude.toFixed(5)}
          </Text>
          {!disabled && (
            <TouchableOpacity onPress={() => onChange(null)}>
              <Text style={s.clear}>Clear</Text>
            </TouchableOpacity>
          )}
        </View>
      ) : (
        <Text style={s.hint}>Not anchored</Text>
      )}

      <MapPickerModal
        visible={mapOpen}
        initial={value}
        onPick={(c) => onChange(c)}
        onClose={() => setMapOpen(false)}
      />
    </View>
  );
}

const s = StyleSheet.create({
  btn: { backgroundColor: '#F1F5F9', borderRadius: radii.md, paddingVertical: 11, paddingHorizontal: spacing.base, borderWidth: 1, borderColor: colors.textDisabled, alignItems: 'center' },
  btnSet: { backgroundColor: '#F0FDF4', borderColor: '#86EFAC' },
  btnText: { fontSize: fontSizes.body, color: colors.textSecondary, fontWeight: '600' },
  btnTextSet: { color: colors.success, fontWeight: '700' },
  manualRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  manualInput: { flex: 1 },
  invalid: { fontSize: fontSizes.caption, color: colors.warning, marginTop: 2 },
  resolvedRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.sm },
  resolved: { fontSize: fontSizes.body2, color: colors.success, fontWeight: '700' },
  clear: { fontSize: fontSizes.body2, color: colors.warning, fontWeight: '600' },
  hint: { fontSize: fontSizes.caption, color: colors.textMuted, textAlign: 'center', marginTop: 4 },
  denied: { fontSize: fontSizes.caption, color: colors.warning, textAlign: 'center', paddingVertical: spacing.sm },
});
