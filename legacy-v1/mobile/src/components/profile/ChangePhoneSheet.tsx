import { useEffect, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { EntityEditSheet } from '../ui/EntityEditSheet';
import { TextField } from '../ui/TextField';
import { Alert } from '../../lib/themedAlert';
import { useSession } from '../../hooks/useSession';
import { validatePhone } from '../../lib/validation';
import { updatePhoneOnline } from '../../api/me';
import { updateUserLocal } from '../../db/queries/users';
import { bumpDataVersion } from '../../sync/dataVersion';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Current normalized phone from the local users row (prefills the field). */
  currentPhone: string | null;
}

/**
 * My Profile → Change phone (role-dashboards spec §4). Format validation only
 * (no SMS infra): validatePhone normalizes (optional leading '+', 7–15 digits
 * after stripping separators), blank clears. PATCH /me/phone, then mirror into
 * the local users row (no outbox — the server committed it and bumped
 * updated_at for sync).
 */
export function ChangePhoneSheet({ visible, onClose, currentPhone }: Props) {
  const s = useThemedStyles(makeStyles);
  const { user } = useSession();

  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) { setPhone(currentPhone ?? ''); setError(null); }
  }, [visible, currentPhone]);

  const handleSave = async () => {
    const v = validatePhone(phone);
    if (!v.ok) {
      setError(v.error);
      throw new Error('validation'); // keep the sheet open
    }
    setError(null);
    try {
      await updatePhoneOnline(v.value);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update your phone number.');
      throw err;
    }
    if (user) {
      updateUserLocal(user.id, { phone: v.value });
      bumpDataVersion();
    }
    Alert.alert('Phone updated', v.value ? `Your phone is now ${v.value}.` : 'Your phone number was cleared.');
  };

  return (
    <EntityEditSheet
      visible={visible}
      onClose={onClose}
      title="📱 Change phone"
      onSave={handleSave}
      saveLabel="Save phone"
    >
      <View style={s.fields}>
        <TextField
          label="Phone number"
          value={phone}
          onChangeText={setPhone}
          error={error}
          hint="Optional + then 7–15 digits. Leave blank to remove."
          placeholder="+1 555 123 4567"
          keyboardType="phone-pad"
          autoFocus
        />
      </View>
    </EntityEditSheet>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  fields: { gap: t.spacing.md },
});
