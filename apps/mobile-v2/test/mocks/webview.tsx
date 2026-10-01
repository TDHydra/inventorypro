// react-native-webview renders a native view; under jest it becomes an inert
// host component so a screen that embeds one (labels preview, map) still mounts.
import { View } from 'react-native';
export function WebView(props: Record<string, unknown>) {
  return <View testID="mock-webview" {...props} />;
}
export default WebView;
