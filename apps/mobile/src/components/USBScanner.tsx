import { useRef, useEffect } from 'react';
import { TextInput, StyleSheet } from 'react-native';

interface Props {
  onScanned: (data: string) => void;
  active: boolean;
}

export function USBScanner({ onScanned, active }: Props) {
  const buffer = useRef('');
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    if (active) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [active]);

  if (!active) return null;

  const handleChange = (text: string) => {
    if (text.endsWith('\n') || text.endsWith('\r')) {
      const code = text.replace(/[\r\n]/g, '').trim();
      if (code.length > 0) {
        onScanned(code);
      }
      // Clear the input after scan
      inputRef.current?.setNativeProps({ text: '' });
    }
  };

  return (
    <TextInput
      ref={inputRef}
      style={styles.hidden}
      onChangeText={handleChange}
      autoFocus
      autoCapitalize="none"
      autoCorrect={false}
      blurOnSubmit={false}
      onBlur={() => {
        // Refocus so scanner input isn't lost
        setTimeout(() => inputRef.current?.focus(), 50);
      }}
    />
  );
}

const styles = StyleSheet.create({
  hidden: {
    position: 'absolute',
    top: -1000,
    left: -1000,
    width: 1,
    height: 1,
    opacity: 0,
  },
});
