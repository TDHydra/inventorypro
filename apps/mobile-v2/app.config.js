// Dynamic Expo config (mobile-v2). Base config lives in app.json; this file
// layers two things on top:
//
// 1. APP_VARIANT=development → applicationId gets a `.v2` suffix and the app
//    is named "InventoryPro Dev", so the rebuild's dev client installs
//    ALONGSIDE the production app on the same device (no data-wiping
//    uninstall during the migration soak). Release builds keep
//    com.inventorypro.app — the fleet updates in place and google-services.json
//    (keyed to that package name) stays valid. The dev variant therefore also
//    drops googleServicesFile + the expo-notifications plugin: FCM config for
//    a package name that doesn't match would fail the build, and the dev
//    client doesn't need push.
//
// 2. The same local plugin chain as the old app (see apps/mobile/app.config.js
//    for the full rationale): expo-build-properties (R8 + keep rules for
//    op-sqlite/Hermes) → withReleaseSigning → withReleaseFlagSecure → Sentry.
//    GOOGLE_SERVICES_JSON is the EAS file-type env var used by cloud builds.
const IS_DEV = process.env.APP_VARIANT === 'development';

module.exports = ({ config }) => {
  const android = { ...config.android };
  if (IS_DEV) {
    android.package = `${config.android.package}.v2`;
    delete android.googleServicesFile;
  } else {
    android.googleServicesFile =
      process.env.GOOGLE_SERVICES_JSON ?? config.android?.googleServicesFile ?? './google-services.json';
  }

  const basePlugins = (config.plugins ?? []).filter(
    p => !(IS_DEV && (p === 'expo-notifications' || (Array.isArray(p) && p[0] === 'expo-notifications'))),
  );

  return {
    ...config,
    name: IS_DEV ? 'InventoryPro Dev' : config.name,
    android,
    ios: IS_DEV
      ? { ...config.ios, bundleIdentifier: `${config.ios.bundleIdentifier}.v2` }
      : config.ios,
    plugins: [
      ...basePlugins,
      [
        'expo-build-properties',
        {
          android: {
            enableProguardInReleaseBuilds: true,
            enableShrinkResourcesInReleaseBuilds: true,
            extraProguardRules: [
              '-keep class com.op.sqlite.** { *; }',
              '-keep class com.facebook.hermes.** { *; }',
            ].join('\n'),
          },
        },
      ],
      './plugins/withReleaseSigning',
      './plugins/withReleaseFlagSecure',
      [
        '@sentry/react-native/expo',
        {
          organization: 'inventorypro',
          project: 'mobile',
          url: 'https://errors.invenpro.app',
        },
      ],
    ],
  };
};
