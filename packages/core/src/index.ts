// @invenpro/core — platform-free sync/data layer shared by mobile-v2, web and
// (from Phase 7) api-v2's contract tests. Configure before use:
//   configureCore({...}) + setDbProvider(...) at app startup.

export * from './config';
export * from './db/provider';
export * from './db/tx';
export * from './db/baseline';
export * from './db/appSettings';
export * from './db/appConfig';
export * from './cache/createConfigCache';
export * from './repo/createRepository';

export * from './manifest/types';
export * from './manifest/derive';
export { TABLES } from './manifest/tables';

export * from './sync/dataVersion';
export * from './sync/connectivityStore';
export * from './sync/heartbeat';
export * from './sync/rejectionClassify';
export * from './sync/requestRef';
export * from './sync/sandbox';
export * from './sync/denialMessages';
export * from './sync/outbox';
export * from './sync/pull';
export * from './sync/fullDownload';
export * from './sync/afterPull';
export * from './sync/engine';

export * from './auth/sessionExpiredBus';
export * from './auth/reauthCore';
export * from './auth/roster';
export * from './auth/pin';

export * from './hooks/useDataVersion';
export * from './hooks/useDbQuery';
export * from './hooks/useReactiveRows';
