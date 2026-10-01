// Render tests for the Media hub screen.
import { screen, fireEvent } from '@testing-library/react-native';
import { renderScreen } from '../../../test/renderScreen';
import { seed, initPageDb } from '../../../test/pageTestDb';
import { stackScreenOptions } from '../../../test/mocks/expoRouter';
import MediaHubScreen from './index';

const TS = '2026-01-01T00:00:00Z';

function seedJob(id: string, name: string, status: string) {
  seed('jobs', {
    id, name, status, created_by: 'user-1', created_at: TS, updated_at: TS, job_number: 1,
  });
}

function seedMedia(id: string, entityType: string, entityId: string, note: string) {
  seed('media', {
    id, entity_type: entityType, entity_id: entityId, media_type: 'photo',
    url: `file:///${id}.jpg`, location_note: note, is_primary: 0, created_at: TS, updated_at: TS,
  });
}

beforeEach(async () => { await initPageDb(); });

test('renders the empty state when there is no media', async () => {
  await renderScreen(<MediaHubScreen />);
  expect(screen.getByText('No media on open jobs')).toBeOnTheScreen();
  expect(screen.getByText('Photos and videos added on jobs show up here.')).toBeOnTheScreen();
});

test('sets the native header title', async () => {
  await renderScreen(<MediaHubScreen />);
  expect(stackScreenOptions).toContainEqual(
    expect.objectContaining({ title: 'Media', headerShown: true }),
  );
});

test('the default Open jobs filter lists media on open jobs only', async () => {
  seedJob('j-open', 'Open Job', 'open');
  seedJob('j-closed', 'Closed Job', 'closed');
  seedMedia('m1', 'job', 'j-open', 'Kitchen wall');
  seedMedia('m2', 'job', 'j-closed', 'Garage floor');
  seedMedia('m3', 'pool', 'pool', 'Shared roof shot');
  await renderScreen(<MediaHubScreen />);

  expect(screen.getByText('Kitchen wall')).toBeOnTheScreen();
  expect(screen.queryByText('Garage floor')).not.toBeOnTheScreen();
  expect(screen.queryByText('Shared roof shot')).not.toBeOnTheScreen();
  expect(screen.getByText('1 item')).toBeOnTheScreen();
});

test('the All jobs and Shared filters change what is listed', async () => {
  seedJob('j-open', 'Open Job', 'open');
  seedJob('j-closed', 'Closed Job', 'closed');
  seedMedia('m1', 'job', 'j-open', 'Kitchen wall');
  seedMedia('m2', 'job', 'j-closed', 'Garage floor');
  seedMedia('m3', 'pool', 'pool', 'Shared roof shot');
  await renderScreen(<MediaHubScreen />);

  await fireEvent.press(screen.getByText('All jobs'));
  expect(screen.getByText('Garage floor')).toBeOnTheScreen();
  expect(screen.queryByText('Shared roof shot')).not.toBeOnTheScreen();

  await fireEvent.press(screen.getByText('Shared'));
  expect(screen.getByText('Shared roof shot')).toBeOnTheScreen();
  expect(screen.queryByText('Kitchen wall')).not.toBeOnTheScreen();
});

test('the Shared filter has its own empty state', async () => {
  await renderScreen(<MediaHubScreen />);
  await fireEvent.press(screen.getByText('Shared'));
  expect(screen.getByText('No shared photos yet')).toBeOnTheScreen();
});

test('the Everything filter is gated on view_all_logs', async () => {
  await renderScreen(<MediaHubScreen />, { permissions: { view_all_logs: false } });
  expect(screen.getByText('Open jobs')).toBeOnTheScreen();
  expect(screen.queryByText('Everything')).not.toBeOnTheScreen();
});

test('the Everything filter is offered to an admin', async () => {
  await renderScreen(<MediaHubScreen />);
  expect(screen.getByText('Everything')).toBeOnTheScreen();
});

test('shows the Share media FAB', async () => {
  await renderScreen(<MediaHubScreen />);
  expect(screen.getByLabelText('Share media')).toBeOnTheScreen();
});
