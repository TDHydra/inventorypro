import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  initialState,
  open,
  chooseDest,
  photoTaken,
  cameraCancelled,
  saveDone,
  saveAndAddAnother,
  cancelDetails,
  buildUploadInput,
} from './quickPhotoLogic';

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

  s = photoTaken(s, 'file://photo.jpg');
  assert.equal(s.phase, 'details');
  assert.deepEqual(s.dest, jobDest);
  assert.equal(s.photoUri, 'file://photo.jpg');

  s = saveDone(s);
  assert.equal(s.phase, 'closed');
  assert.equal(s.dest, null);
  assert.equal(s.photoUri, null);
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
