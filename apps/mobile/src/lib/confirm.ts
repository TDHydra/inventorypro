import { Alert } from 'react-native';

/** Two-button destructive confirm. The confirm button uses the iOS 'destructive' style. */
export function confirmDestructive(opts: { title: string; message?: string; confirmLabel: string; onConfirm: () => void }): void {
  Alert.alert(opts.title, opts.message, [
    { text: 'Cancel', style: 'cancel' },
    { text: opts.confirmLabel, style: 'destructive', onPress: opts.onConfirm },
  ]);
}
