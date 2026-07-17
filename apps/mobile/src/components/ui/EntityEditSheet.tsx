import React, { useState, useCallback } from 'react';
import { Text, StyleSheet } from 'react-native';
import { ModalSheet } from './ModalSheet';
import { FormActions } from './FormActions';
import { colors } from '../../theme';

interface Props {
  visible: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  /** The screen's save handler. It owns ALL persistence (updateXFields /
   *  appendOutbox / appendLog — the query-layer outbox contracts diverge per
   *  entity, see docs/COMPONENTIZATION-PLAN.md) and any error alerts. Throw to
   *  keep the sheet open. */
  onSave: () => void | Promise<void>;
  saveLabel?: string;
  disabled?: boolean;
}

/**
 * ModalSheet + title + fields + FormActions — the entity edit sheet shape
 * (reference: the Edit Team modal at (teams)/[id].tsx). Persistence-agnostic:
 * the sheet only sequences busy state and close-on-success; it never touches
 * the outbox/log/db and never alerts.
 */
export function EntityEditSheet({ visible, onClose, title, children, onSave, saveLabel = 'Save', disabled }: Props) {
  const [busy, setBusy] = useState(false);

  const handleSave = useCallback(async () => {
    setBusy(true);
    try {
      await onSave();
      onClose();
    } catch {
      // Stay open so the user can retry; the screen's onSave already alerted.
    } finally {
      setBusy(false);
    }
  }, [onSave, onClose]);

  return (
    <ModalSheet visible={visible} onClose={onClose} scroll>
      <Text style={s.title}>{title}</Text>
      {children}
      <FormActions onCancel={onClose} onSave={handleSave} saveLabel={saveLabel} busy={busy} disabled={disabled} />
    </ModalSheet>
  );
}

const s = StyleSheet.create({
  title: { fontSize: 18, fontWeight: '700', color: colors.textPrimary, marginBottom: 14 },
});
