import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shareLinkEndpoint, parseShareLinkBody } from './shareLink';

// Pure logic for #180 external share (v1: link-only). No react-native/expo
// imports in shareLink.ts, so this runs directly under `node --test`.

test('shareLinkEndpoint builds the POST /media/:id/share-link URL', () => {
  assert.equal(
    shareLinkEndpoint('http://localhost:3000', 'media-1'),
    'http://localhost:3000/media/media-1/share-link',
  );
});

test('shareLinkEndpoint encodes an id with URL-unsafe characters', () => {
  assert.equal(
    shareLinkEndpoint('http://localhost:3000', 'a/b c'),
    'http://localhost:3000/media/a%2Fb%20c/share-link',
  );
});

test('parseShareLinkBody extracts shareUrl from a well-formed response', () => {
  assert.equal(parseShareLinkBody({ shareUrl: 'https://x/y.jpg?sig=1', expiresInSeconds: 604800 }), 'https://x/y.jpg?sig=1');
});

test('parseShareLinkBody returns null for a missing shareUrl', () => {
  assert.equal(parseShareLinkBody({ expiresInSeconds: 604800 }), null);
});

test('parseShareLinkBody returns null for a non-string shareUrl', () => {
  assert.equal(parseShareLinkBody({ shareUrl: 42 }), null);
});

test('parseShareLinkBody returns null for an empty-string shareUrl', () => {
  assert.equal(parseShareLinkBody({ shareUrl: '' }), null);
});

test('parseShareLinkBody returns null for non-object bodies', () => {
  assert.equal(parseShareLinkBody(null), null);
  assert.equal(parseShareLinkBody(undefined), null);
  assert.equal(parseShareLinkBody('oops'), null);
  assert.equal(parseShareLinkBody(42), null);
});
