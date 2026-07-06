import React, { useState, useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Alert } from '../lib/themedAlert';
import { ModalSheet } from './ui/ModalSheet';
import { PrimaryButton } from './ui/PrimaryButton';
import { FilterChip } from './ui/FilterChip';
import { colors, spacing, fontSizes } from '../theme';
import {
  printLabels,
  printLabelsWithModel,
  LabelTemplate,
  LABEL_TEMPLATES,
  BarcodeFormat,
  type LabelItem,
} from '../labels/printLabel';
import { getLabelTemplates } from '../db/queries/labelTemplates';
import type { LabelTemplateModel } from '../labels/positioned';

interface Props {
  visible: boolean;
  onClose: () => void;
  items: LabelItem[];
}

const TEMPLATE_CHIPS: { key: LabelTemplate; label: string }[] = (
  Object.keys(LABEL_TEMPLATES) as LabelTemplate[]
).map((key) => ({ key, label: LABEL_TEMPLATES[key].name }));

const FORMAT_CHIPS: { key: BarcodeFormat; label: string }[] = [
  { key: 'qr', label: 'QR code' },
  { key: 'code128', label: 'Barcode (Code 128)' },
];

type Selection = { kind: 'preset'; key: LabelTemplate } | { kind: 'custom'; id: string };

/**
 * Batch sibling of LabelPrintSheet — same preset + custom-template chooser, but
 * prints N labels (from a bulk selection) in one job. Presets → printLabels;
 * a designed template → printLabelsWithModel (positioned render).
 */
export function BatchLabelPrintSheet({ visible, onClose, items }: Props) {
  const customTemplates = useMemo<LabelTemplateModel[]>(
    () => (visible ? getLabelTemplates() : []),
    [visible],
  );
  const [sel, setSel] = useState<Selection>({ kind: 'preset', key: 'standard' });
  const [format, setFormat] = useState<BarcodeFormat>('qr');
  const [printing, setPrinting] = useState(false);

  async function handlePrint() {
    if (items.length === 0) { onClose(); return; }
    setPrinting(true);
    try {
      if (sel.kind === 'custom') {
        const model = customTemplates.find((t) => t.id === sel.id);
        if (!model) throw new Error('Template not found.');
        await printLabelsWithModel(items, model);
      } else {
        await printLabels(items, sel.key, format);
      }
      onClose();
    } catch (err) {
      Alert.alert('Print failed', err instanceof Error ? err.message : 'An error occurred.');
    } finally {
      setPrinting(false);
    }
  }

  return (
    <ModalSheet visible={visible} onClose={onClose}>
      <Text style={s.heading}>Print {items.length} label{items.length === 1 ? '' : 's'}</Text>

      {customTemplates.length > 0 && (
        <>
          <Text style={s.sectionLabel}>Custom templates</Text>
          <View style={s.chips}>
            {customTemplates.map((t) => (
              <FilterChip key={t.id} label={t.name}
                active={sel.kind === 'custom' && sel.id === t.id}
                onPress={() => setSel({ kind: 'custom', id: t.id })} />
            ))}
          </View>
        </>
      )}

      <Text style={s.sectionLabel}>Label size</Text>
      <View style={s.chips}>
        {TEMPLATE_CHIPS.map(({ key, label }) => (
          <FilterChip key={key} label={label}
            active={sel.kind === 'preset' && sel.key === key}
            onPress={() => setSel({ kind: 'preset', key })} />
        ))}
      </View>

      {sel.kind === 'preset' && (
        <>
          <Text style={s.sectionLabel}>Symbol</Text>
          <View style={s.chips}>
            {FORMAT_CHIPS.map(({ key, label }) => (
              <FilterChip key={key} label={label} active={format === key} onPress={() => setFormat(key)} />
            ))}
          </View>
        </>
      )}

      <View style={s.footer}>
        <PrimaryButton label={`Print ${items.length}`} onPress={handlePrint} loading={printing} disabled={printing} />
      </View>
    </ModalSheet>
  );
}

const s = StyleSheet.create({
  heading: { fontSize: fontSizes.lg, fontWeight: '700', color: colors.textPrimary, marginBottom: spacing.lg },
  sectionLabel: { fontSize: fontSizes.caption, fontWeight: '600', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: spacing.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.xl },
  footer: { marginTop: spacing.sm },
});
