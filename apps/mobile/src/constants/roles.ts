export type UserRole =
  | 'full_admin'
  | 'franchise_manager'
  | 'hr_manager'
  | 'office_manager'
  | 'head_of_construction'
  | 'head_of_contents'
  | 'production_manager'
  | 'carpet_cleaning_manager'
  | 'construction_crew'
  | 'contents_crew'
  | 'mitigation_technician'
  | 'carpet_cleaning_crew'
  | 'temporary_employee';

export type Permission =
  | 'checkout_inventory'
  | 'checkin_inventory'
  | 'add_inventory'
  | 'edit_inventory'
  | 'delete_inventory'
  | 'transfer_between_locations'
  | 'create_jobs'
  | 'close_jobs'
  | 'manage_locations'
  | 'upload_media'
  | 'view_all_logs'
  | 'view_own_logs'
  | 'manage_teams'
  | 'checkout_for_team'
  | 'manage_users'
  | 'set_pins'
  | 'manage_roles_permissions'
  | 'view_financial_data'
  | 'system_settings';

export const ROLE_TIER: Record<UserRole, 1 | 2 | 3 | 4> = {
  temporary_employee:       1,
  carpet_cleaning_crew:     1,
  mitigation_technician:    1,
  contents_crew:            1,
  construction_crew:        1,
  carpet_cleaning_manager:  2,
  production_manager:       2,
  head_of_contents:         2,
  head_of_construction:     2,
  office_manager:           3,
  hr_manager:               3,
  franchise_manager:        4,
  full_admin:               4,
};

export const PIN_LENGTH_BY_TIER: Record<1 | 2 | 3 | 4, number> = {
  1: 4,
  2: 6,
  3: 6,
  4: 8,
};

export const ROLE_DISPLAY_NAMES: Record<UserRole, string> = {
  full_admin:               'Full Admin',
  franchise_manager:        'Franchise Manager/Owner',
  hr_manager:               'HR Manager',
  office_manager:           'Office Manager',
  head_of_construction:     'Head of Construction',
  head_of_contents:         'Head of Contents',
  production_manager:       'Production Manager',
  carpet_cleaning_manager:  'Carpet Cleaning Manager',
  construction_crew:        'Construction Crew',
  contents_crew:            'Contents Crew',
  mitigation_technician:    'Mitigation Technician',
  carpet_cleaning_crew:     'Carpet Cleaning Crew',
  temporary_employee:       'Temporary Employee',
};

type PermissionMap = Record<Permission, boolean>;

const tier4: PermissionMap = {
  checkout_inventory:        true,
  checkin_inventory:         true,
  add_inventory:             true,
  edit_inventory:            true,
  delete_inventory:          true,
  transfer_between_locations:true,
  create_jobs:               true,
  close_jobs:                true,
  manage_locations:          true,
  upload_media:              true,
  view_all_logs:             true,
  view_own_logs:             true,
  manage_teams:              true,
  checkout_for_team:         true,
  manage_users:              true,
  set_pins:                  true,
  manage_roles_permissions:  true,
  view_financial_data:       true,
  system_settings:           true,
};

const tier3: PermissionMap = {
  checkout_inventory:        false,
  checkin_inventory:         false,
  add_inventory:             false,
  edit_inventory:            false,
  delete_inventory:          false,
  transfer_between_locations:false,
  create_jobs:               true,
  close_jobs:                true,
  manage_locations:          false,
  upload_media:              true,
  view_all_logs:             true,
  view_own_logs:             true,
  manage_teams:              false,
  checkout_for_team:         false,
  manage_users:              true,
  set_pins:                  true,
  manage_roles_permissions:  false,
  view_financial_data:       true,
  system_settings:           false,
};

const tier2: PermissionMap = {
  checkout_inventory:         true,
  checkin_inventory:          true,
  add_inventory:              true,
  edit_inventory:             true,
  delete_inventory:           false,
  transfer_between_locations: true,
  create_jobs:                true,
  close_jobs:                 true,
  manage_locations:           true,
  upload_media:               true,
  view_all_logs:              true,
  view_own_logs:              true,
  manage_teams:               true,
  checkout_for_team:          true,
  manage_users:               false,
  set_pins:                   false,
  manage_roles_permissions:   false,
  view_financial_data:        false,
  system_settings:            false,
};

const tier1: PermissionMap = {
  checkout_inventory:         true,
  checkin_inventory:          true,
  add_inventory:              false,
  edit_inventory:             false,
  delete_inventory:           false,
  transfer_between_locations: false,
  create_jobs:                false,
  close_jobs:                 false,
  manage_locations:           false,
  upload_media:               true,
  view_all_logs:              false,
  view_own_logs:              true,
  manage_teams:               false,
  checkout_for_team:          true,
  manage_users:               false,
  set_pins:                   false,
  manage_roles_permissions:   false,
  view_financial_data:        false,
  system_settings:            false,
};

const tempEmployee: PermissionMap = {
  ...tier1,
  checkin_inventory:  false,
  upload_media:       false,
  checkout_for_team:  false,
};

export const ROLE_DEFAULTS: Record<UserRole, PermissionMap> = {
  full_admin:               tier4,
  franchise_manager:        tier4,
  hr_manager:               tier3,
  office_manager:           { ...tier3, view_financial_data: true },
  head_of_construction:     tier2,
  head_of_contents:         tier2,
  production_manager:       tier2,
  carpet_cleaning_manager:  tier2,
  construction_crew:        tier1,
  contents_crew:            tier1,
  mitigation_technician:    tier1,
  carpet_cleaning_crew:     tier1,
  temporary_employee:       tempEmployee,
};
