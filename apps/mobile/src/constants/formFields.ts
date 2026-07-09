/**
 * Identifiers for individually hideable optional form fields.
 *
 * Only genuinely optional fields are listed here — required fields
 * (those enforced as non-null by API schema guards) are excluded.
 * Hidden state is stored in app_config under the key "hidden_fields"
 * as a JSON-encoded FormFieldId[] array and synced to every device.
 */
export type FormFieldId =
  | 'inventory.barcode'
  | 'inventory.description'
  | 'inventory.supplier'
  | 'inventory.model'
  | 'inventory.min_qty_alert'
  | 'inventory.reorder_to'
  | 'inventory.home_location'
  | 'inventory.pack_size'
  | 'jobs.customer_name'
  | 'jobs.site_address'
  | 'jobs.site_location'
  | 'jobs.reference_number'
  | 'jobs.insurance_carrier'
  | 'jobs.description';

/** Human-readable label for each hideable field, used in the admin UI. */
export const FORM_FIELD_LABELS: Record<FormFieldId, string> = {
  'inventory.barcode':      'Item barcode',
  'inventory.description':  'Item description',
  'inventory.supplier':     'Supplier',
  'inventory.model':        'Model',
  'inventory.min_qty_alert':'Low-stock alert',
  'inventory.reorder_to':   'Reorder-to quantity',
  'inventory.home_location':'Home location',
  'inventory.pack_size':    'Pack size',
  'jobs.customer_name':     'Customer name',
  'jobs.site_address':      'Site address',
  'jobs.site_location':     'Site location',
  'jobs.reference_number':  'Reference #',
  'jobs.insurance_carrier': 'Insurance carrier',
  'jobs.description':       'Job description',
};

/** Ordered list of all hideable field IDs. */
export const ALL_FORM_FIELD_IDS: FormFieldId[] = Object.keys(
  FORM_FIELD_LABELS
) as FormFieldId[];
