import { useSyncExternalStore } from 'react';
import {
  getHiddenFields,
  subscribeHiddenFields,
  getHiddenFieldsVersion,
} from '../db/hiddenFields';
import { FormFieldId } from '../constants/formFields';

/**
 * Reactive hook that returns the current set of admin-hidden optional fields.
 * Re-renders whenever the set changes — either because the admin toggled a
 * field in the Settings screen (notifyHiddenFieldsChanged called after commit)
 * or because a sync pull delivered a new hidden_fields app_config row.
 *
 * Mirrors the usePermission pattern: useSyncExternalStore subscribes to the
 * version counter, and each re-render reads the DB fresh via getHiddenFields().
 */
export function useHiddenFields(): {
  hiddenFields: Set<FormFieldId>;
  isHidden: (id: FormFieldId) => boolean;
} {
  useSyncExternalStore(
    subscribeHiddenFields,
    getHiddenFieldsVersion,
    getHiddenFieldsVersion,
  );
  const hiddenFields = getHiddenFields();
  return {
    hiddenFields,
    isHidden: (id: FormFieldId) => hiddenFields.has(id),
  };
}
