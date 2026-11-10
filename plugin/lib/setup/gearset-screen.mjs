// The Gearset screen of Set up: its words, as plain data the page draws from.
//
//   GEARSET_SCREEN   deep-frozen, with part 'gearset':
//                    the heading; the pipeline picker (its label, the read button before and
//                    after the first read and while it runs, Save and its line while it runs, the
//                    line when the token sees no pipeline, and the one before a pipeline is
//                    picked); the environment table's headings; the flag lines of an environment
//                    no org matches and of Gearset's production environment; the line of a stage
//                    no environment deploys to (the page fills in {org} and {stage}); each CI
//                    job's state (enabled, off, none); the test-level lines of a stage: checked
//                    by Foreman ({tests}, {stage}), no tests ({stage}), not shown by Gearset, and
//                    confirmed by the owner ({date}), with the confirm and undo buttons; and
//                    `errors`, what lib/setup/gearset.mjs answers with ({status} in other).
//
// No click path and no guide text: those are the step's guide, in steps.mjs. This file
// imports nothing: steps.mjs imports it, and gearset.mjs imports it.

const freeze = (v) => {
  if (v && typeof v === 'object') {
    for (const x of Object.values(v)) freeze(x);
    Object.freeze(v);
  }
  return v;
};

export const GEARSET_SCREEN = freeze({
  part: 'gearset',
  heading: 'Which Gearset pipeline promotes this repo?',

  picker: {
    label: 'Gearset pipeline',
    read: 'Read the pipelines',
    readAgain: 'Read again',
    reading: 'Reading Gearset…',
    save: 'Save the pipeline',
    saving: 'Saving…',
    noPipelines: 'Gearset shows no pipeline to this token. Check that the token belongs to the team that owns the pipeline.',
    pickFirst: 'Pick a pipeline to see its environments.',
  },

  table: {
    environment: 'Gearset environment',
    gearsetStage: 'Gearset stage',
    org: 'Org',
    stage: 'Foreman stage',
    ciJob: 'CI job',
  },

  flags: {
    unmatched: 'No org in salesforce.orgs has this org ID',
    production: "Gearset's production environment: Foreman never promotes here",
  },
  missing: 'No Gearset environment in this pipeline deploys to {org}, the org of stage {stage}',

  ciJob: {
    enabled: 'On',
    off: 'Turned off',
    none: 'No CI job',
  },

  testsChecked: "Checked: {tests} Apex tests ran in Gearset's last deploy to {stage}.",
  testsNone: "Gearset's last deploy to {stage} ran no Apex tests. Set a test level on the CI job in Gearset.",
  testsUnknown: "Gearset does not show a CI job's test level, and no recent deploy shows it. Check the CI job in Gearset, then confirm here.",
  confirmedByYou: "Confirmed by you on {date}. Foreman checks it again after Gearset's next deploy.",
  confirm: 'I set a test level on this CI job',
  unconfirm: 'Undo',

  errors: {
    tokenFirst: 'Save GEARSET_API_TOKEN first.',
    badToken: 'Gearset did not accept GEARSET_API_TOKEN. Make a new access token in Gearset and save it on the key card below.',
    tier: "Gearset's API is not on for this token's team: it needs Gearset's Teams or Enterprise tier.",
    tooMany: 'Gearset says too many requests were made. Try again in a minute.',
    unreachable: 'Foreman could not reach Gearset. Check the connection and try again.',
    other: 'Gearset answered {status}.',
    notGearset: 'This project does not release through Gearset: salesforce.release is not gearset.',
    badPipeline: 'Pick a pipeline from the list.',
    badStage: 'Pick a stage from salesforce.stages.',
    badBody: 'Foreman could not read that request.',
    nothingChanged: 'Nothing changed.',
    setupFirst: 'Finish set-up first: this project has no working foreman.config.json yet.',
    notSaved: 'Foreman could not save foreman.config.json. Check that the file can be written, then try again.',
  },
});
