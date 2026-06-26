import { View, Text, StyleSheet } from 'react-native';
import { Stack } from 'expo-router';
export default function SettingsScreen() {
  return (
    <>
      <Stack.Screen options={{ title: 'Settings', headerShown: true }} />
      <View style={s.c}><Text style={s.t}>Settings — coming soon</Text></View>
    </>
  );
}
const s = StyleSheet.create({ c: { flex:1, alignItems:'center', justifyContent:'center' }, t: { fontSize:18, color:'#94A3B8' } });
