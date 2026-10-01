// Render tests for Settings -> Hidden Fields.
import { screen, fireEvent } from '@testing-library/react-native';
import { renderScreen } from '../../../test/renderScreen';
import { seed, initPageDb, getDb } from '../../../test/pageTestDb';
import { navCalls, stackScreenOptions } from '../../../test/mocks/expoRouter';

import HiddenFieldsSettings from './fields';
import { FORM_FIELD_LABELS } from '../../../src/constants/formFields';

beforeEach(async () => { await initPageDb(); });

test('renders the intro and one switch per optional field', async () => {
  await renderScreen(<HiddenFieldsSettings />);
  expect(screen.getByText('Hide optional fields')).toBeOnTheScreen();
  expect(screen.getAllByRole('switch').length).toBe(Object.keys(FORM_FIELD_LABELS).length);
});

test('sets the native header title', async () => {
  await renderScreen(<HiddenFieldsSettings />);
  expect(stackScreenOptions).toContainEqual(expect.objectContaining({ title: 'Hidden Fields' }));
});

test('without system_settings shows the no-access message', async () => {
  await renderScreen(<HiddenFieldsSettings />, { role: 'contents_crew' });
  expect(screen.getByText(/don't have access to hidden fields/)).toBeOnTheScreen();
  expect(screen.queryByRole('switch')).not.toBeOnTheScreen();
});

test('toggling a field writes hidden_fields app_config and queues an outbox row', async () => {
  // The write also appends an activity_log row whose user_id is an FK to users.
  seed('users', {
    id: 'user-1', name: 'Dev Tester', role: 'full_admin', pin_length_required: 4,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  });
  await renderScreen(<HiddenFieldsSettings />);
  await fireEvent(screen.getAllByRole('switch')[0], 'valueChange', true);
  const cfg = getDb().executeSync("SELECT value FROM app_config WHERE key = 'hidden_fields'").rows as { value: string }[];
  expect(JSON.parse(cfg[0].value)).toHaveLength(1);
  const ob = getDb().executeSync("SELECT * FROM outbox WHERE table_name = 'app_config'").rows;
  expect(ob.length).toBe(1);
});

test('a field already hidden in app_config renders its switch on', async () => {
  seed('app_config', { key: 'hidden_fields', value: JSON.stringify(['inventory.barcode']), updated_at: '2026-01-01T00:00:00Z' });
  await renderScreen(<HiddenFieldsSettings />);
  const on = screen.getAllByRole('switch').filter(sw => sw.props.value === true);
  expect(on.length).toBe(1);
});
