import React, { useState, useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Alert } from '../lib/themedAlert';
import { ModalSheet } from './ui/ModalSheet';
import { PrimaryButton } from './ui/PrimaryButton';
import { FilterChip } from './ui/FilterChip';
import { colors, spacing, fontSizes } from '../theme';
import {
  printLabel,
  printLabelsWithModel,
  LabelTemplate,
  LABEL_TEMPLATES,
  BarcodeFormat,
  payloadFromQrUrl,
} from '../labels/printLabel';
import { getLabelTemplates } from '../db/queries/labelTemplates';
import type { LabelTemplateModel } from '../labels/positioned';

interface Props {
  visible: boolean;
  onClose: () => void;
  title: string;
  code: string;
  qrUrl: string;
  /** Optional explicit scan payload; otherwise derived from `qrUrl`. Additive. */
  payload?: string;
}

// Built-in preset chips derived from the shared presets (DYMO / Zebra / Avery /
// generic) so the printer list stays in sync with printLabel.ts.
const TEMPLATE_CHIPS: { key: LabelTemplate; label: string }[] = (
  Object.keys(LABEL_TEMPLATES) as LabelTemplate[]
).map((key) => ({ key, label: LABEL_TEMPLATES[key].name }));

const FORMAT_CHIPS: { key: BarcodeFormat; label: string }[] = [
  { key: 'qr', label: 'QR code' },
  { key: 'code128', label: 'Barcode (Code 128)' },
];

// A preset selection (key + format) or a custom designed template (by id).
type Selection =
  | { kind: 'preset'; key: LabelTemplate }
  | { kind: 'custom'; id: string };

export function LabelPrintSheet({ visible, onClose, title, code, qrUrl, payload }: Props) {
  // Custom templates are org-synced; re-read whenever the sheet opens so a newly
  // designed template shows up without remounting.
  const customTemplates = useMemo<LabelTemplateModel[]>(
    () => (visible ? getLabelTemplates() : []),
    [visible],
  );
  const [sel, setSel] = useState<Selection>({ kind: 'preset', key: 'standard' });
  const [format, setFormat] = useState<BarcodeFormat>('qr');
  const [printing, setPrinting] = useState(false);

  async function handlePrint() {
    setPrinting(true);
    try {
      if (sel.kind === 'custom') {
        const model = customTemplates.find((t) => t.id === sel.id);
        if (!model) throw new Error('Template not found.');
        const item = { title, code, payload: payload ?? payloadFromQrUrl(qrUrl) };
        await printLabelsWithModel([item], model);
      } else {
        await printLabel({ title, code, qrUrl, template: sel.key, format, payload });
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
      <Text style={s.heading}>Print Label</Text>
      <Text style={s.subheading}>{title}</Text>

      {customTemplates.length > 0 && (
        <>
          <Text style={s.sectionLabel}>Custom templates</Text>
          <View style={s.chips}>
            {customTemplates.map((t) => (
              <FilterChip
                key={t.id}
                label={t.name}
                active={sel.kind === 'custom' && sel.id === t.id}
                onPress={() => setSel({ kind: 'custom', id: t.id })}
              />
            ))}
          </View>
        </>
      )}

      <Text style={s.sectionLabel}>Label size</Text>
      <View style={s.chips}>
        {TEMPLATE_CHIPS.map(({ key, label }) => (
          <FilterChip
            key={key}
            label={label}
            active={sel.kind === 'preset' && sel.key === key}
            onPress={() => setSel({ kind: 'preset', key })}
          />
        ))}
      </View>

      {/* Symbol only applies to presets — custom templates carry their own fields. */}
      {sel.kind === 'preset' && (
        <>
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
        </>
      )}

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
