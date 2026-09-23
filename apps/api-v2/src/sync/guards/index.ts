import { registerTableGuard } from '../registry';
import { activityLogGuard } from './activityLog';
import { appConfigGuard } from './appConfig';
import { roleSettingsGuard } from './roleSettings';
import { foreignUnitGuard } from './foreignUnit';
import { usersGuard } from './users';
import { mediaGuard } from './media';
import { notificationsGuard } from './notificationsRows';
import { messagesGuard, conversationParticipantsGuard, conversationsGuard } from './chat';
import { vehicleAliasRemap, locationsGuard } from './locations';
import { subteamsGuard } from './subteams';
import { unitAccessGuard } from './unitAccess';
import { vehiclesGuard } from './vehicles';
import { vehicleCheckoutsGuard } from './vehicleCheckouts';

// Registration order IS the check order within each phase (the registry runs
// guards in this order), and rejection precedence is part of the wire
// contract — this list mirrors the old monolith's top-to-bottom pipeline
// exactly. The old locker_access guard is gone: the table is no longer
// allowlisted (PUSH_TABLES from the manifest), so those writes reject at the
// allowlist step instead.
export function registerSyncGuards(): void {
  // preAuthorize phase (before test-account / maintenance / privileged gates)
  registerTableGuard(activityLogGuard);
  // privileged phase (right after the privileged-table permission gate)
  registerTableGuard(appConfigGuard);
  registerTableGuard(roleSettingsGuard); // also afterApply: perm-touch
  // authorizeRow phase (after the operation-permission gate)
  registerTableGuard(foreignUnitGuard); // '*': #162 foreign-team unit check
  registerTableGuard(usersGuard); // also afterApply: perm-touch
  registerTableGuard(mediaGuard); // also afterApply: cleanup + pool notify
  registerTableGuard(notificationsGuard);
  registerTableGuard(messagesGuard); // also afterApply: chat push
  registerTableGuard(conversationParticipantsGuard);
  registerTableGuard(conversationsGuard);
  registerTableGuard(vehicleAliasRemap); // '*': #129 in-batch id remap
  registerTableGuard(locationsGuard);
  registerTableGuard(subteamsGuard);
  registerTableGuard(unitAccessGuard);
  registerTableGuard(vehiclesGuard);
  registerTableGuard(vehicleCheckoutsGuard);
}
