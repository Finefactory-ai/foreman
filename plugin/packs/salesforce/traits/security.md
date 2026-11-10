Salesforce security checks:

- Apex enforces CRUD and FLS: queries use `WITH USER_MODE`, and DML uses `AccessLevel.USER_MODE` or `Security.stripInaccessible`.
- Apex classes are declared `with sharing`, unless a comment in the class says why not.
- No SOQL injection: no query is built by concatenating input; use bind variables or `String.escapeSingleQuotes`.
- Nothing new is exposed to guest users: no guest access to records, Apex or Flows unless the story asks for it.
- Secrets and endpoints live in Named Credentials only, never in code, custom settings or other metadata.
