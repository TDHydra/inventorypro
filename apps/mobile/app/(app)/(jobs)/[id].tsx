import { View, Text, StyleSheet } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
export default function JobDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <>
      <Stack.Screen options={{ title: 'Job Detail', headerShown: true }} />
      <View style={s.c}><Text style={s.t}>Job {id} — detail coming soon</Text></View>
    </>
  );
}
const s = StyleSheet.create({ c: { flex:1, alignItems:'center', justifyContent:'center' }, t: { fontSize:15, color:'#94A3B8' } });
