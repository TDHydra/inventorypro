import type { TextInputProps } from 'react-native';
import { AppInput } from './AppInput';

/**
 * Search box — thin AppInput wrapper so the ~25 raw list-screen search
 * TextInputs share one themed seam (pill inputs on Fluid, square on
 * Futuristic, etc. come from the input descriptor for free).
 */
export function SearchInput(props: TextInputProps) {
  return (
    <AppInput
      autoCapitalize="none"
      autoCorrect={false}
      clearButtonMode="while-editing"
      returnKeyType="search"
      {...props}
    />
  );
}
