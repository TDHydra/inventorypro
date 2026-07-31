export type QuickPhotoDest =
  | { kind: 'job'; jobId: string; jobName: string }
  | { kind: 'pool'; audience: 'team' | 'everyone' | 'users'; userIds: string[] };

// #171: where the photo(s) come from. The destination/audience phase below is
// reused UNCHANGED for both — only what happens after chooseDest differs
// (launch the camera for one shot, or the gallery picker for up to 10).
export type QuickPhotoSource = 'camera' | 'gallery';

export type QuickPhotoPhase = 'closed' | 'destination' | 'camera' | 'gallery' | 'details';

// A single picked-but-not-yet-uploaded asset — gallery multi-select queues
// these; the camera path only ever produces one at a time (never queued).
export interface QuickPhotoAsset {
  uri: string;
  mediaType: 'image' | 'video';
  ext: string;
}

export interface QuickPhotoState {
  phase: QuickPhotoPhase;
  source: QuickPhotoSource;
  dest: QuickPhotoDest | null;
  photoUri: string | null;
  mediaType: 'image' | 'video';
  ext: string;
  // Gallery-only: assets picked but not yet run through the details phase.
  // "Save & add another" pops the next one instead of relaunching the picker
  // (sequential — one presigned upload at a time, same as MediaGallery's
  // runUploadQueue). Always empty for the camera source.
  queue: QuickPhotoAsset[];
}

export interface UploadInput {
  entityType: string;
  entityId: string;
  locationNote: string | null;
  caption: string | null;
  audience: 'team' | 'everyone' | 'users' | null;
  audienceUserIds: string[] | null;
}

export function initialState(): QuickPhotoState {
  return {
    phase: 'closed',
    source: 'camera',
    dest: null,
    photoUri: null,
    mediaType: 'image',
    ext: 'jpg',
    queue: [],
  };
}

export function open(s: QuickPhotoState, source: QuickPhotoSource = 'camera'): QuickPhotoState {
  if (s.phase !== 'closed') {
    return s;
  }
  return {
    ...s,
    phase: 'destination',
    source,
    queue: [],
  };
}

export function chooseDest(s: QuickPhotoState, dest: QuickPhotoDest): QuickPhotoState {
  if (s.phase !== 'destination') {
    return s;
  }
  return {
    ...s,
    phase: s.source === 'gallery' ? 'gallery' : 'camera',
    dest,
  };
}

export function photoTaken(s: QuickPhotoState, uri: string): QuickPhotoState {
  if (s.phase !== 'camera') {
    return s;
  }
  return {
    ...s,
    phase: 'details',
    photoUri: uri,
    mediaType: 'image',
    ext: 'jpg',
  };
}

// Gallery multi-pick lands here: the first asset feeds the details phase now,
// the rest queue up behind it (see saveAndAddAnother).
export function assetsPicked(s: QuickPhotoState, assets: QuickPhotoAsset[]): QuickPhotoState {
  if (s.phase !== 'gallery' || assets.length === 0) {
    return s;
  }
  const [first, ...rest] = assets;
  return {
    ...s,
    phase: 'details',
    photoUri: first.uri,
    mediaType: first.mediaType,
    ext: first.ext,
    queue: rest,
  };
}

export function cameraCancelled(s: QuickPhotoState): QuickPhotoState {
  if (s.phase !== 'camera') {
    return s;
  }
  return initialState();
}

export function galleryCancelled(s: QuickPhotoState): QuickPhotoState {
  if (s.phase !== 'gallery') {
    return s;
  }
  return initialState();
}

export function saveDone(s: QuickPhotoState): QuickPhotoState {
  if (s.phase !== 'details') {
    return s;
  }
  return initialState();
}

// Camera source: clears the photo and returns to 'camera' to relaunch it.
// Gallery source: pops the next queued asset straight into 'details' (no
// picker relaunch); an empty queue has nothing left to add, so it behaves
// exactly like saveDone.
export function saveAndAddAnother(s: QuickPhotoState): QuickPhotoState {
  if (s.phase !== 'details') {
    return s;
  }
  if (s.source === 'gallery') {
    if (s.queue.length === 0) {
      return initialState();
    }
    const [next, ...rest] = s.queue;
    return {
      ...s,
      phase: 'details',
      photoUri: next.uri,
      mediaType: next.mediaType,
      ext: next.ext,
      queue: rest,
    };
  }
  return {
    ...s,
    phase: 'camera',
    photoUri: null,
  };
}

export function cancelDetails(s: QuickPhotoState): QuickPhotoState {
  if (s.phase !== 'details') {
    return s;
  }
  return initialState();
}

function trimToNull(str: string): string | null {
  const trimmed = str.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function buildUploadInput(
  dest: QuickPhotoDest,
  userId: string,
  roomArea: string,
  note: string,
): UploadInput {
  const locationNote = trimToNull(roomArea);
  const caption = trimToNull(note);

  if (dest.kind === 'job') {
    return {
      entityType: 'job',
      entityId: dest.jobId,
      locationNote,
      caption,
      audience: null,
      audienceUserIds: null,
    };
  }

  // dest.kind === 'pool'
  const audience = dest.audience;
  const audienceUserIds =
    audience === 'users' && dest.userIds.length > 0 ? dest.userIds : null;

  return {
    entityType: 'pool',
    entityId: userId,
    locationNote,
    caption,
    audience,
    audienceUserIds,
  };
}
