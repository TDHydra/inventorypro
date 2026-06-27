import { getAppSetting, setAppSetting } from './appSettings';
import { getAppConfig, setAppConfigLocal } from './appConfig';
import { appendOutbox } from '../sync/outbox';

export type FormMode = 'simple' | 'detailed';

/**
 * Resolves the effective form mode for the current user+device.
 * Precedence: user local override → admin synced default → 'detailed'.
 */
export function getFormMode(): FormMode {
  const override = getAppSetting('form_mode_override'); // 'simple' | 'detailed' | '' | null
  if (override === 'simple' || override === 'detailed') return override;
  const def = getAppConfig('form_mode_default'); // 'simple' | 'detailed' | null
  return def === 'simple' ? 'simple' : 'detailed';
}

/** Reads the admin-set app-wide default (synced via app_config). */
export function getFormModeDefault(): FormMode {
  return getAppConfig('form_mode_default') === 'simple' ? 'simple' : 'detailed';
}

/**
 * Admin action: set the app-wide default form mode.
 * Writes locally AND pushes through the outbox so it syncs to every device
 * (identical pattern to setMaintenanceMode).
 */
export function setFormModeDefault(mode: FormMode): void {
  setAppConfigLocal('form_mode_default', mode);
  appendOutbox('INSERT', 'app_config', {
    key: 'form_mode_default',
    value: mode,
    updated_at: new Date().toISOString(),
  });
}

/** Reads the user's local override, or null if none is set. */
export function getFormModeOverride(): FormMode | null {
  const v = getAppSetting('form_mode_override');
  return v === 'simple' || v === 'detailed' ? v : null;
}

/**
 * Sets the user's local override. Pass null to clear it ("use app default").
 * Sentinel: empty string '' = unset (never synced — local only).
 */
export function setFormModeOverride(mode: FormMode | null): void {
  if (mode == null) {
    setAppSetting('form_mode_override', '');
  } else {
    setAppSetting('form_mode_override', mode);
  }
}
