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
});
