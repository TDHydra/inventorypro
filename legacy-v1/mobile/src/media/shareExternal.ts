import { Share } from 'react-native';
import { Alert } from '../lib/themedAlert';
import { getValidJwt } from '../auth/session';
import { shareLinkEndpoint, parseShareLinkBody } from './shareLink';

// #180 v1: external share (Android share sheet) hands the OS a LINK, not a
// file — RN core Share.share({ message: url }) only takes text. File sharing
// (expo-sharing, attaching the actual image bytes) is deferred to the next
// native rebuild since expo-sharing is a native module and would break hotload.

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';

// Mints a longer-lived presigned link from the server (POST /media/:id/share-link)
// and opens the native share sheet with it. Call sites should gate on
// `!isMediaUploadPending(mediaId)` first — the mint endpoint reads the media row
// from Postgres, so a row that hasn't reached the server yet 404s; this function
// still fails gracefully (a friendly alert) if that happens anyway.
export async function shareMediaExternally(mediaId: string): Promise<void> {
  const jwt = await getValidJwt();
  if (!jwt) {
    Alert.alert('Offline', 'Connect to the internet to share this photo.');
    return;
  }

  let shareUrl: string | null = null;
  try {
    const res = await fetch(shareLinkEndpoint(API_BASE, mediaId), {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}` },
    });
    if (res.ok) shareUrl = parseShareLinkBody(await res.json());
  } catch {
    shareUrl = null;
  }

  if (!shareUrl) {
    Alert.alert('Could not share', 'This photo could not be shared right now. Check your connection and try again.');
    return;
  }

  try {
    await Share.share({ message: shareUrl });
  } catch {
    // User cancelled, or the OS share sheet failed — nothing actionable to show.
  }
}
