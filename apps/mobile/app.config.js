// Dynamic Expo config. Everything still lives in app.json (spread in as `config`);
// this file exists only so EAS *cloud* builds can supply google-services.json —
// which is gitignored and therefore NOT part of the EAS project upload. Create a
// file-type EAS env var named GOOGLE_SERVICES_JSON (see below) and EAS materializes
// it to a path at build time; we point googleServicesFile at that path. Local
// builds (env var absent) fall back to the checked-out ./google-services.json.
//
//   eas env:create --environment production  --name GOOGLE_SERVICES_JSON --type file --value ./google-services.json --visibility sensitive
//   eas env:create --environment preview      --name GOOGLE_SERVICES_JSON --type file --value ./google-services.json --visibility sensitive
//   eas env:create --environment development   --name GOOGLE_SERVICES_JSON --type file --value ./google-services.json --visibility sensitive
module.exports = ({ config }) => ({
  ...config,
  android: {
    ...config.android,
    googleServicesFile:
      process.env.GOOGLE_SERVICES_JSON ?? config.android?.googleServicesFile ?? './google-services.json',
  },
  // Local config plugins (in ./plugins) are appended to the plugins declared in
  // app.json so their prebuild mods survive `expo prebuild --clean`:
  //  - expo-build-properties: enables R8 code shrinking + resource shrinking on
  //    release builds. Must run BEFORE withReleaseSigning so the signingConfig
  //    injection sees the final buildTypes block. Keep rules are minimal:
  //    expo-modules-core / react-native ship their own consumer rules;
  //    op-sqlite does not, and Hermes is kept defensively (JNI-reflected).
  //  - withReleaseSigning: re-injects the release keystore signingConfig into
  //    android/app/build.gradle (sourced from gitignored android/keystore.properties,
  //    debug fallback when absent).
  //  - withReleaseFlagSecure: sets app-wide Android FLAG_SECURE on release builds.
  plugins: [
    ...(config.plugins ?? []),
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
  ],
});
