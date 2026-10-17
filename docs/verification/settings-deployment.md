# Categorized settings production deployment — 2026-10-17

The hosted UI was built from the committed `07b02171` snapshot and deployed
through the existing Seoul HTTPS entry to the Tokyo Core. Uncommitted Android,
identity-refresh, and CI work was excluded. The backend executable was not
changed or restarted; this release updates its served frontend resources.

The exact snapshot passed 23 isolated workspace checks. The existing official
0.9.1 portable client passed all 15 isolated login and account-workspace checks
against that snapshot. All test mutations used disposable synthetic accounts.

Before switching the HTML entry, the old UI was backed up and new hashed assets
were added. Existing assets remain available for already-open clients. All
seven files matched the release manifest over public HTTPS; the root entry
matched too. Health returned 200 and the unauthenticated API returned 401.
The service PID was unchanged. Account databases and credentials were untouched.

The local Windows installation was replaced from the verified official 0.9.1
unpacked package, retaining the shortcut icon and the existing profile. All 78
runtime files matched their source hashes. The encrypted saved-login file was
unchanged during replacement. The normal installed application was reopened.
The shell version remains 0.9.1 because this update changes the hosted UI only.

Evidence, manifests, scripts, and the local installation backup reference are
under ignored `release/deployment-settings-07b02171/`. The remote pre-deployment
UI backup is `ui-settings-07b02171-20261017-pre` under the Core backup directory.

Production verification was read-only. No test messages or account mutations
were performed against the user's live workspace. Opening the installed app
does not constitute a new live-account interaction test; its behavior was
verified using the isolated packaged-client fixture above.
