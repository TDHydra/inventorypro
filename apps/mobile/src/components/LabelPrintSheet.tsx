import React, { useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Alert } from '../lib/themedAlert';
import { ModalSheet } from './ui/ModalSheet';
import { PrimaryButton } from './ui/PrimaryButton';
import { FilterChip } from './ui/FilterChip';
import { colors, spacing, fontSizes } from '../theme';
import {
  printLabel,
  LabelTemplate,
  LABEL_TEMPLATES,
  BarcodeFormat,
} from '../labels/printLabel';

interface Props {
  visible: boolean;
  onClose: () => void;
  title: string;
  code: string;
  qrUrl: string;
  /** Optional explicit scan payload; otherwise derived from `qrUrl`. Additive. */
  payload?: string;
}

// Preset chips are derived from the shared template presets (DYMO / Zebra /
// Avery / generic) so the printer list stays in sync with printLabel.ts.
const TEMPLATE_CHIPS: { key: LabelTemplate; label: string }[] = (
  Object.keys(LABEL_TEMPLATES) as LabelTemplate[]
).map((key) => ({ key, label: LABEL_TEMPLATES[key].name }));

const FORMAT_CHIPS: { key: BarcodeFormat; label: string }[] = [
  { key: 'qr', label: 'QR code' },
  { key: 'code128', label: 'Barcode (Code 128)' },
];

export function LabelPrintSheet({ visible, onClose, title, code, qrUrl, payload }: Props) {
  const [template, setTemplate] = useState<LabelTemplate>('standard');
  const [format, setFormat] = useState<BarcodeFormat>('qr');
  const [printing, setPrinting] = useState(false);

  async function handlePrint() {
    setPrinting(true);
    try {
      await printLabel({ title, code, qrUrl, template, format, payload });
    } catch (err) {
      Alert.alert('Print failed', err instanceof Error ? err.message : 'An error occurred.');
    } finally {
      setPrinting(false);
    }
  }

  return (
    <ModalSheet visible={visible} onClose={onClose}>
      <Text style={s.heading}>Print Label</Text>
      <Text style={s.subheading}>{title}</Text>

      <Text style={s.sectionLabel}>Label size</Text>
      <View style={s.chips}>
        {TEMPLATE_CHIPS.map(({ key, label }) => (
          <FilterChip
            key={key}
            label={label}
            active={template === key}
            onPress={() => setTemplate(key)}
          />
        ))}
      </View>

      <Text style={s.sectionLabel}>Symbol</Text>
      <View style={s.chips}>
        {FORMAT_CHIPS.map(({ key, label }) => (
          <FilterChip
            key={key}
            label={label}
            active={format === key}
            onPress={() => setFormat(key)}
          />
        ))}
      </View>

      <View style={s.footer}>
        <PrimaryButton
          label="Print"
          onPress={handlePrint}
          loading={printing}
          disabled={printing}
        />
      </View>
    </ModalSheet>
  );
}

const s = StyleSheet.create({
  heading: {
    fontSize: fontSizes.lg,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: spacing.xs,
  },
  subheading: {
    fontSize: fontSizes.body,
    color: colors.textSecondary,
    marginBottom: spacing.xl,
  },
  sectionLabel: {
    fontSize: fontSizes.caption,
    fontWeight: '600',
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.sm,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.xl,
  },
  footer: {
    marginTop: spacing.sm,
  },
});
