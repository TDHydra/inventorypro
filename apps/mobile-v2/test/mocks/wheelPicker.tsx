// @quidone/react-native-wheel-picker drives a native scroll view. Rendered as
// an inert view: page tests assert the surrounding form, not wheel physics.
import { View } from 'react-native';
export function WheelPicker(props: Record<string, unknown>) {
  return <View testID="mock-wheel-picker" {...props} />;
}
export default WheelPicker;
