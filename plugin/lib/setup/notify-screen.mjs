// The notifications screen of Set up: its words, as plain data the page draws from.
//
//   NOTIFY_SCREEN   deep-frozen, with part 'notify': the choice (email through Resend, or none),
//                   the sender and recipient cards' titles and notes, the line shown when
//                   foreman.config.json sets either, the test button, and `results`, the words for
//                   each outcome of a test email (lib/setup/notify.mjs testResult). The page fills
//                   in {from} and {to}; the server fills in {to}, {missing} and {reason}
//
// This file imports nothing: steps.mjs imports it.

const freeze = (v) => {
  if (v && typeof v === 'object') {
    for (const x of Object.values(v)) freeze(x);
    Object.freeze(v);
  }
  return v;
};

export const NOTIFY_SCREEN = freeze({
  part: 'notify',
  heading: 'How should Foreman tell you when a story ships, fails or needs an answer?',
  choices: [
    { value: 'email-resend', label: 'Email, through Resend' },
    { value: 'none', label: 'No email: notifications go to the outbox only' },
  ],
  fromTitle: 'Sender address',
  fromNote: 'An address on a domain you have verified at Resend, such as foreman@yourdomain.com.',
  fromConfig: 'foreman.config.json sends from {from}, and that wins over this key.',
  toTitle: 'Your address',
  toNote: 'Leave it empty to use your git email.',
  toConfig: 'foreman.config.json sends to {to}, and that wins over this key.',
  send: 'Send a test email',
  sending: 'Sending the test email…',
  localOnly:
    'A test email can be sent only from a dashboard that listens on this computer alone (127.0.0.1). To use it from another machine, open it through an SSH tunnel.',
  badChoice: 'Choose email or none.',
  nothingChanged: 'Nothing changed.',
  setupFirst: 'Finish set-up first: this project has no working foreman.config.json yet.',
  results: {
    sent: 'Sent to {to}. It should arrive within a minute; check spam too.',
    outboxOff:
      'Notifications are off in Settings (features.notifications), so the test went to the outbox only. Turn them on to get email.',
    outboxNone: 'This project is set to no email, so the test went to the outbox only.',
    missing: 'Save {missing} first.',
    badKey: 'Resend did not accept the key. Make a new one under resend.com > API Keys and save it above.',
    inactiveKey: 'Resend says the key is not active. Make a new one under resend.com > API Keys and save it above.',
    unverified:
      "The sender address's domain is not verified at Resend. Verify it under resend.com > Domains, or use an address on a domain that is.",
    testingOnly: 'Resend sends only to your own Resend address until you verify a domain. Verify one under resend.com > Domains.',
    tooMany: 'Resend says too many emails were sent. Try again in a minute.',
    unreachable: 'Foreman could not reach Resend. Check the connection and try again.',
    other: 'Resend did not send it: {reason}',
    badBlock: "foreman.config.json's notify block is wrong: {reason}",
  },
});
