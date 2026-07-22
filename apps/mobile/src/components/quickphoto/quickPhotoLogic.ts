export type QuickPhotoDest =
  | { kind: 'job'; jobId: string; jobName: string }
  | { kind: 'pool'; audience: 'team' | 'everyone' | 'users'; userIds: string[] };

export type QuickPhotoPhase = 'closed' | 'destination' | 'camera' | 'details';

export interface QuickPhotoState {
  phase: QuickPhotoPhase;
  dest: QuickPhotoDest | null;
  photoUri: string | null;
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
    dest: null,
    photoUri: null,
  };
}

export function open(s: QuickPhotoState): QuickPhotoState {
  if (s.phase !== 'closed') {
    return s;
  }
  return {
    ...s,
    phase: 'destination',
  };
}

export function chooseDest(s: QuickPhotoState, dest: QuickPhotoDest): QuickPhotoState {
  if (s.phase !== 'destination') {
    return s;
  }
  return {
    ...s,
    phase: 'camera',
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
  };
}

export function cameraCancelled(s: QuickPhotoState): QuickPhotoState {
  if (s.phase !== 'camera') {
    return s;
  }
  return {
    phase: 'closed',
    dest: null,
    photoUri: null,
  };
}

export function saveDone(s: QuickPhotoState): QuickPhotoState {
  if (s.phase !== 'details') {
    return s;
  }
  return {
    phase: 'closed',
    dest: null,
    photoUri: null,
  };
}

export function saveAndAddAnother(s: QuickPhotoState): QuickPhotoState {
  if (s.phase !== 'details') {
    return s;
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
  return {
    phase: 'closed',
    dest: null,
    photoUri: null,
  };
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
