import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  initialState,
  open,
  chooseDest,
  photoTaken,
  assetsPicked,
  cameraCancelled,
  galleryCancelled,
  saveDone,
  saveAndAddAnother,
  cancelDetails,
  buildUploadInput,
  type QuickPhotoAsset,
} from './quickPhotoLogic';

// #188: minimal File stand-ins for node:test (no DOM File constructor) — used
// to prove the *reference* survives phase transitions untouched, which is the
// actual bug-fix mechanism (upload.web.ts streams this exact object).
const FAKE_FILE_A = { name: 'a.jpg' } as unknown as File;
const FAKE_FILE_B = { name: 'b.mp4' } as unknown as File;

// Happy path: job destination
test('happy path job: open → chooseDest → photoTaken → saveDone → closed', () => {
  let s = initialState();
  assert.equal(s.phase, 'closed');
  assert.equal(s.dest, null);
  assert.equal(s.photoUri, null);

  s = open(s);
  assert.equal(s.phase, 'destination');
  assert.equal(s.dest, null);
  assert.equal(s.photoUri, null);

  const jobDest = { kind: 'job' as const, jobId: 'j1', jobName: 'Build' };
  s = chooseDest(s, jobDest);
  assert.equal(s.phase, 'camera');
  assert.deepEqual(s.dest, jobDest);
  assert.equal(s.photoUri, null);

  // #188: a File carried alongside the uri (web camera capture) must survive
  // the photoTaken transition unchanged — it's what upload.web.ts streams.
  s = photoTaken(s, 'file://photo.jpg', FAKE_FILE_A);
  assert.equal(s.phase, 'details');
  assert.deepEqual(s.dest, jobDest);
  assert.equal(s.photoUri, 'file://photo.jpg');
  assert.equal(s.photoFile, FAKE_FILE_A);

  s = saveDone(s);
  assert.equal(s.phase, 'closed');
  assert.equal(s.dest, null);
  assert.equal(s.photoUri, null);
  assert.equal(s.photoFile, undefined);
});

// Happy path: pool team destination
test('happy path pool team: open → chooseDest → photoTaken → saveDone → closed', () => {
  let s = initialState();
  const poolDest = { kind: 'pool' as const, audience: 'team' as const, userIds: [] };

  s = open(s);
  s = chooseDest(s, poolDest);
  assert.equal(s.phase, 'camera');

  s = photoTaken(s, 'file://photo.jpg');
  assert.equal(s.phase, 'details');

  s = saveDone(s);
  assert.equal(s.phase, 'closed');
  assert.equal(s.dest, null);
  assert.equal(s.photoUri, null);
});

// Happy path: pool users destination
test('happy path pool users: open → chooseDest → photoTaken → saveDone → closed', () => {
  let s = initialState();
  const poolDest = { kind: 'pool' as const, audience: 'users' as const, userIds: ['u2', 'u3'] };

  s = open(s);
  s = chooseDest(s, poolDest);
  assert.equal(s.phase, 'camera');

  s = photoTaken(s, 'file://photo.jpg');
  assert.equal(s.phase, 'details');

  s = saveDone(s);
  assert.equal(s.phase, 'closed');
});

// Save & add another keeps destination, clears photo, returns to camera
test('save & add another keeps destination, clears photo, returns to camera', () => {
  let s = initialState();
  s = open(s);
  const poolDest = { kind: 'pool' as const, audience: 'team' as const, userIds: [] };
  s = chooseDest(s, poolDest);
  s = photoTaken(s, 'file://a.jpg');

  s = saveAndAddAnother(s);
  assert.equal(s.phase, 'camera');
  assert.deepEqual(s.dest, poolDest);
  assert.equal(s.photoUri, null);
});

// cameraCancelled resets to closed from camera phase
test('cameraCancelled from camera resets to closed with dest/photo nulled', () => {
  let s = initialState();
  s = open(s);
  const jobDest = { kind: 'job' as const, jobId: 'j1', jobName: 'Build' };
  s = chooseDest(s, jobDest);
  s = photoTaken(s, 'file://photo.jpg');

  // Back to camera phase first
  const back = cameraCancelled(s);
  // cameraCancelled from details should be a no-op
  assert.equal(back.phase, 'details');

  // Try from camera phase
  s = initialState();
  s = open(s);
  s = chooseDest(s, jobDest);
  s = cameraCancelled(s);
  assert.equal(s.phase, 'closed');
  assert.equal(s.dest, null);
  assert.equal(s.photoUri, null);
});

// cancelDetails resets to closed from details phase
test('cancelDetails from details resets to closed with dest/photo nulled', () => {
  let s = initialState();
  s = open(s);
  const jobDest = { kind: 'job' as const, jobId: 'j1', jobName: 'Build' };
  s = chooseDest(s, jobDest);
  s = photoTaken(s, 'file://photo.jpg');

  s = cancelDetails(s);
  assert.equal(s.phase, 'closed');
  assert.equal(s.dest, null);
  assert.equal(s.photoUri, null);
});

// buildUploadInput: job destination
test('buildUploadInput: job dest → entityType:job, audience:null', () => {
  const r = buildUploadInput(
    { kind: 'job', jobId: 'j1', jobName: 'Build' },
    'u1',
    'Kitchen',
    'Photo of work',
  );
  assert.deepEqual(r, {
    entityType: 'job',
    entityId: 'j1',
    locationNote: 'Kitchen',
    caption: 'Photo of work',
    audience: null,
    audienceUserIds: null,
  });
});

// buildUploadInput: pool team destination
test('buildUploadInput: pool team → entityType:pool, audience:team', () => {
  const r = buildUploadInput(
    { kind: 'pool', audience: 'team', userIds: [] },
    'u1',
    'Kitchen',
    'Photo',
  );
  assert.deepEqual(r, {
    entityType: 'pool',
    entityId: 'u1',
    locationNote: 'Kitchen',
    caption: 'Photo',
    audience: 'team',
    audienceUserIds: null,
  });
});

// buildUploadInput: pool everyone destination
test('buildUploadInput: pool everyone → entityType:pool, audience:everyone', () => {
  const r = buildUploadInput(
    { kind: 'pool', audience: 'everyone', userIds: [] },
    'u1',
    'Kitchen',
    'Photo',
  );
  assert.deepEqual(r, {
    entityType: 'pool',
    entityId: 'u1',
    locationNote: 'Kitchen',
    caption: 'Photo',
    audience: 'everyone',
    audienceUserIds: null,
  });
});

// buildUploadInput: pool users share
test('buildUploadInput: pool users share → audienceUserIds passed through', () => {
  const r = buildUploadInput(
    { kind: 'pool', audience: 'users', userIds: ['u2'] },
    'u1',
    ' Kitchen ',
    '',
  );
  assert.deepEqual(r, {
    entityType: 'pool',
    entityId: 'u1',
    locationNote: 'Kitchen',
    caption: null,
    audience: 'users',
    audienceUserIds: ['u2'],
  });
});

// buildUploadInput: empty roomArea string → null
test('buildUploadInput: empty roomArea string → null', () => {
  const r = buildUploadInput(
    { kind: 'job', jobId: 'j1', jobName: 'Build' },
    'u1',
    '',
    'Caption',
  );
  assert.equal(r.locationNote, null);
});

// buildUploadInput: whitespace-only roomArea → null
test('buildUploadInput: whitespace-only roomArea → null', () => {
  const r = buildUploadInput(
    { kind: 'job', jobId: 'j1', jobName: 'Build' },
    'u1',
    '   ',
    'Caption',
  );
  assert.equal(r.locationNote, null);
});

// buildUploadInput: roomArea trimmed
test('buildUploadInput: roomArea trimmed correctly', () => {
  const r = buildUploadInput(
    { kind: 'job', jobId: 'j1', jobName: 'Build' },
    'u1',
    '  Kitchen  ',
    'Caption',
  );
  assert.equal(r.locationNote, 'Kitchen');
});

// buildUploadInput: empty note string → null
test('buildUploadInput: empty note string → null', () => {
  const r = buildUploadInput(
    { kind: 'job', jobId: 'j1', jobName: 'Build' },
    'u1',
    'Kitchen',
    '',
  );
  assert.equal(r.caption, null);
});

// buildUploadInput: whitespace-only note → null
test('buildUploadInput: whitespace-only note → null', () => {
  const r = buildUploadInput(
    { kind: 'job', jobId: 'j1', jobName: 'Build' },
    'u1',
    'Kitchen',
    '   ',
  );
  assert.equal(r.caption, null);
});

// buildUploadInput: note trimmed
test('buildUploadInput: note trimmed correctly', () => {
  const r = buildUploadInput(
    { kind: 'job', jobId: 'j1', jobName: 'Build' },
    'u1',
    'Kitchen',
    '  Caption  ',
  );
  assert.equal(r.caption, 'Caption');
});

// buildUploadInput: pool users with empty list → audienceUserIds null
test('buildUploadInput: pool users with empty list → audienceUserIds null', () => {
  const r = buildUploadInput(
    { kind: 'pool', audience: 'users', userIds: [] },
    'u1',
    'Kitchen',
    'Caption',
  );
  assert.equal(r.audienceUserIds, null);
});

// buildUploadInput: pool users with non-empty list → audienceUserIds passed
test('buildUploadInput: pool users with multiple userIds → audienceUserIds passed', () => {
  const r = buildUploadInput(
    { kind: 'pool', audience: 'users', userIds: ['u2', 'u3'] },
    'u1',
    'Kitchen',
    'Caption',
  );
  assert.deepEqual(r.audienceUserIds, ['u2', 'u3']);
});

// Invalid phase transitions return state unchanged
test('open from non-closed phase is no-op', () => {
  let s = initialState();
  s = open(s);
  const before = s;
  s = open(s);
  assert.deepEqual(s, before);
});

test('chooseDest from non-destination phase is no-op', () => {
  let s = initialState();
  const dest = { kind: 'pool' as const, audience: 'team' as const, userIds: [] };
  s = chooseDest(s, dest);
  assert.equal(s.phase, 'closed');
  assert.equal(s.dest, null);
});

test('photoTaken from non-camera phase is no-op', () => {
  let s = initialState();
  const before = s;
  s = photoTaken(s, 'file://photo.jpg');
  assert.deepEqual(s, before);
});

test('saveDone from non-details phase is no-op', () => {
  let s = initialState();
  s = open(s);
  const before = s;
  s = saveDone(s);
  assert.deepEqual(s, before);
});

test('saveAndAddAnother from non-details phase is no-op', () => {
  let s = initialState();
  s = open(s);
  const before = s;
  s = saveAndAddAnother(s);
  assert.deepEqual(s, before);
});

test('cancelDetails from non-details phase is no-op', () => {
  let s = initialState();
  const before = s;
  s = cancelDetails(s);
  assert.deepEqual(s, before);
});

test('cameraCancelled from non-camera phase is no-op', () => {
  let s = initialState();
  const before = s;
  s = cameraCancelled(s);
  assert.deepEqual(s, before);
});

// ─────────────────────────────────────────────────────────────────────────
// #171: gallery source — same destination/audience phase, then 'gallery'
// instead of 'camera'; multi-pick queues extra assets for saveAndAddAnother.
// ─────────────────────────────────────────────────────────────────────────

test('initialState defaults to camera source and an empty queue', () => {
  const s = initialState();
  assert.equal(s.source, 'camera');
  assert.deepEqual(s.queue, []);
});

test('open(s, "gallery") records the source; open(s) still defaults to camera', () => {
  let s = initialState();
  s = open(s, 'gallery');
  assert.equal(s.phase, 'destination');
  assert.equal(s.source, 'gallery');

  s = initialState();
  s = open(s);
  assert.equal(s.source, 'camera');
});

test('happy path gallery: open(gallery) → chooseDest → gallery phase (not camera)', () => {
  let s = initialState();
  s = open(s, 'gallery');
  const poolDest = { kind: 'pool' as const, audience: 'team' as const, userIds: [] };
  s = chooseDest(s, poolDest);
  assert.equal(s.phase, 'gallery');
  assert.deepEqual(s.dest, poolDest);
});

test('chooseDest with camera source (default) still goes to the camera phase', () => {
  let s = initialState();
  s = open(s);
  const jobDest = { kind: 'job' as const, jobId: 'j1', jobName: 'Build' };
  s = chooseDest(s, jobDest);
  assert.equal(s.phase, 'camera');
});

const TWO_ASSETS: QuickPhotoAsset[] = [
  { uri: 'file://a.jpg', mediaType: 'image', ext: 'jpg', file: FAKE_FILE_A },
  { uri: 'file://b.mp4', mediaType: 'video', ext: 'mp4', file: FAKE_FILE_B },
];

test('assetsPicked from gallery phase: first asset feeds details, the rest queue up', () => {
  let s = initialState();
  s = open(s, 'gallery');
  const poolDest = { kind: 'pool' as const, audience: 'everyone' as const, userIds: [] };
  s = chooseDest(s, poolDest);
  assert.equal(s.phase, 'gallery');

  s = assetsPicked(s, TWO_ASSETS);
  assert.equal(s.phase, 'details');
  assert.equal(s.photoUri, 'file://a.jpg');
  assert.equal(s.mediaType, 'image');
  assert.equal(s.ext, 'jpg');
  // #188: the first asset's File feeds photoFile now; the rest keep THEIR
  // own .file in the queue (each queued asset carries its own File through
  // to whenever it's popped by saveAndAddAnother — see below).
  assert.equal(s.photoFile, FAKE_FILE_A);
  assert.deepEqual(s.queue, [{ uri: 'file://b.mp4', mediaType: 'video', ext: 'mp4', file: FAKE_FILE_B }]);
});

test('assetsPicked from non-gallery phase is a no-op', () => {
  let s = initialState();
  const before = s;
  s = assetsPicked(s, TWO_ASSETS);
  assert.deepEqual(s, before);
});

test('assetsPicked with an empty array is a no-op (cancel path uses galleryCancelled instead)', () => {
  let s = initialState();
  s = open(s, 'gallery');
  s = chooseDest(s, { kind: 'pool', audience: 'team', userIds: [] });
  const before = s;
  s = assetsPicked(s, []);
  assert.deepEqual(s, before);
});

test('galleryCancelled from gallery phase resets fully to closed', () => {
  let s = initialState();
  s = open(s, 'gallery');
  s = chooseDest(s, { kind: 'pool', audience: 'team', userIds: [] });
  s = galleryCancelled(s);
  assert.equal(s.phase, 'closed');
  assert.equal(s.dest, null);
  assert.equal(s.photoUri, null);
  assert.deepEqual(s.queue, []);
});

test('galleryCancelled from non-gallery phase is a no-op', () => {
  let s = initialState();
  const before = s;
  s = galleryCancelled(s);
  assert.deepEqual(s, before);
});

test('saveAndAddAnother (gallery, queue non-empty): pops the next asset into details without relaunching the picker', () => {
  let s = initialState();
  s = open(s, 'gallery');
  s = chooseDest(s, { kind: 'pool', audience: 'team', userIds: [] });
  s = assetsPicked(s, TWO_ASSETS);
  assert.equal(s.queue.length, 1);

  s = saveAndAddAnother(s);
  assert.equal(s.phase, 'details');
  assert.equal(s.photoUri, 'file://b.mp4');
  assert.equal(s.mediaType, 'video');
  assert.equal(s.ext, 'mp4');
  // #188: popping the queue must carry THAT asset's own File along with it —
  // this is what feeds uploadMediaAsset's input for the next save.
  assert.equal(s.photoFile, FAKE_FILE_B);
  assert.deepEqual(s.queue, []);
});

test('saveAndAddAnother (gallery, queue empty): behaves like saveDone — nothing left to add', () => {
  let s = initialState();
  s = open(s, 'gallery');
  s = chooseDest(s, { kind: 'pool', audience: 'team', userIds: [] });
  s = assetsPicked(s, [{ uri: 'file://only.jpg', mediaType: 'image', ext: 'jpg' }]);
  assert.deepEqual(s.queue, []);

  s = saveAndAddAnother(s);
  assert.equal(s.phase, 'closed');
  assert.equal(s.dest, null);
  assert.equal(s.photoUri, null);
});

test('saveAndAddAnother (camera source, default): still relaunches the camera, unaffected by #171', () => {
  let s = initialState();
  s = open(s);
  const poolDest = { kind: 'pool' as const, audience: 'team' as const, userIds: [] };
  s = chooseDest(s, poolDest);
  s = photoTaken(s, 'file://a.jpg', FAKE_FILE_A);

  s = saveAndAddAnother(s);
  assert.equal(s.phase, 'camera');
  assert.deepEqual(s.dest, poolDest);
  assert.equal(s.photoUri, null);
  // #188: relaunching the camera must clear the stale File too, or a second
  // shot's uri could get paired with the FIRST shot's File on upload.
  assert.equal(s.photoFile, undefined);
  assert.deepEqual(s.queue, []);
});

test('saveDone from gallery details closes even with unfinished queue items (Done means stop)', () => {
  let s = initialState();
  s = open(s, 'gallery');
  s = chooseDest(s, { kind: 'pool', audience: 'team', userIds: [] });
  s = assetsPicked(s, TWO_ASSETS);
  assert.equal(s.queue.length, 1);

  s = saveDone(s);
  assert.equal(s.phase, 'closed');
  assert.equal(s.dest, null);
  assert.equal(s.photoUri, null);
  assert.deepEqual(s.queue, []);
});
