import React, { useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Alert } from '../lib/themedAlert';
import { ModalSheet } from './ui/ModalSheet';
import { PrimaryButton } from './ui/PrimaryButton';
import { FilterChip } from './ui/FilterChip';
import { colors, spacing, fontSizes } from '../theme';
import { printLabel, LabelTemplate } from '../labels/printLabel';

interface Props {
  visible: boolean;
  onClose: () => void;
  title: string;
  code: string;
  qrUrl: string;
}

const TEMPLATES: { key: LabelTemplate; label: string }[] = [
  { key: 'small', label: 'Small (2.25×1.25″)' },
  { key: 'standard', label: 'Standard (4×2″)' },
  { key: 'large', label: 'Large (4×3″)' },
];

export function LabelPrintSheet({ visible, onClose, title, code, qrUrl }: Props) {
  const [template, setTemplate] = useState<LabelTemplate>('standard');
  const [printing, setPrinting] = useState(false);

  async function handlePrint() {
    setPrinting(true);
    try {
      await printLabel({ title, code, qrUrl, template });
    } catch (err) {
      Alert.alert('Print failed', err instanceof Error ? err.message : 'An error occurred.');
    } finally {
      setPrinting(false);
    }
  }

  return (
    <ModalSheet visible={visible} onClose={onClose}>
      <Text style={s.heading}>Print QR Label</Text>
      <Text style={s.subheading}>{title}</Text>

      <Text style={s.sectionLabel}>Label size</Text>
      <View style={s.chips}>
        {TEMPLATES.map(({ key, label }) => (
          <FilterChip
            key={key}
            label={label}
            active={template === key}
            onPress={() => setTemplate(key)}
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
