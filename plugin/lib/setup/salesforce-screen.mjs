// The Salesforce org sign-in screen of Set up: its words, as plain data the page draws from.
//
//   SF_SCREEN   deep-frozen, with part 'salesforce':
//               the key card: its heading, the line with no key (none) and with one (ready, the
//               page fills in {fingerprint} and {expires}), the buttons (generate, upload,
//               download, replace, confirm, cancel), the two file fields of an upload, the
//               certificate's download name, and the warning before a replace;
//               the org rows: the line of an org not tested yet, connected or broken (the page
//               fills in {detail} from the org's doctor check) and its roles line ({roles}, or
//               notUsed);
//               the connect form: its fields, the login URL it starts with (defaultInstanceUrl,
//               as packs/salesforce/setup.mjs), the button, the lines while sf runs and once
//               connected ({orgId}), the link to a guide entry ({n}) or a step, the org-ID save,
//               and why nothing can change here (localOnly and keyFirst, as salesforce.mjs WORDS);
//               a Setup-only follow-up's line, from its doctor check: not tested, done, or not
//               ({detail}).
//
// No click path and no guide text: those are the step's guide, in steps.mjs. This file
// imports nothing: steps.mjs imports it, and salesforce.mjs imports steps.mjs.

const freeze = (v) => {
  if (v && typeof v === 'object') {
    for (const x of Object.values(v)) freeze(x);
    Object.freeze(v);
  }
  return v;
};

export const SF_SCREEN = freeze({
  part: 'salesforce',

  heading: "Foreman's key and certificate",
  none: 'No key yet. Make one here, or upload a key and certificate you already have. The key stays on this computer.',
  ready: 'Key ready. Certificate fingerprint {fingerprint}, valid until {expires}.',
  generate: 'Make the key',
  upload: 'Upload the key and certificate',
  keyFile: 'Key file (PEM, no passphrase)',
  certificateFile: 'Certificate file (PEM)',
  download: 'Download the certificate',
  downloadName: 'foreman.crt',
  replace: 'Replace the key',
  replaceWarn: 'The new certificate must be uploaded to the app in every org, and each org connected again.',
  confirm: 'Replace it',
  cancel: 'Cancel',

  rowUntested: 'Not tested yet. Press Test it after connecting.',
  rowConnected: 'Connected: {detail}',
  rowBroken: 'Not working: {detail}',
  roles: 'Used for {roles}',
  notUsed: 'Not used by any step yet',

  username: 'Username Foreman signs in as',
  clientId: 'Consumer key',
  instanceUrl: 'Login URL',
  instanceUrlNote: "Leave it for a sandbox, or give the sandbox's own My Domain address.",
  defaultInstanceUrl: 'https://test.salesforce.com',
  connect: 'Connect',
  connecting: 'Signing in… sf can take up to 2 minutes.',
  connected: 'Connected to org {orgId}.',
  testNext: 'Press Test it to run the org checks.',
  seeStep: 'See step {n}',
  openStep: 'Open that step',
  saveOrgId: 'Save the new org ID',
  localOnly:
    'Salesforce keys and sign-ins work only on a dashboard that listens on this computer alone (127.0.0.1). To use it from another machine, open it through an SSH tunnel.',
  keyFirst: 'Make or upload the key first.',

  followUntested: 'Not checked yet: press Test it once this is done.',
  followDone: 'Done: the doctor check passes.',
  followNot: 'Not done yet: {detail}',
});
