# Release

`npm run release:macos` turns `nsh package`'s ad hoc signed `.app` into a
distributable build: it re-signs with the pinned Developer ID Application
certificate (hardened runtime, secure timestamp), notarizes and staples
`pipi.app` first, wraps that stapled app in the styled DMG (`scripts/make-dmg.sh`,
shared with `package:macos`), signs the disk image, submits the DMG to Apple's
notary service, staples the ticket into the DMG as well, and runs
`codesign --verify --deep --strict`, `stapler validate` and `spctl -a -vv`
before writing `release/verification.json`. Both `pipi.app` inside the DMG and
the outer `.dmg` carry stapled tickets. A missing credential or any failed check
stops the run before an artifact exists; it never falls back to ad hoc signing.

The [release workflow](../.github/workflows/release.yml) does the same on
`macos-15` when a `v*` tag is pushed. Separate `windows-latest` and
`ubuntu-24.04` jobs run `nsh check` before packaging the Windows installer /
`.zip` and Linux `.tar.gz` (all non-macOS artifacts are unsigned — Windows
SmartScreen will warn on first launch); a final job publishes all of it as one
GitHub Release. A manual dispatch runs every gate but publishes nothing. The
tag must equal `v` + `nsh.json`'s version — bump `nsh.json` first.

The publish job also runs `nsh publish` into a signed `.nshpkg` of the app's
code and `nsh update-manifest --package … --key …` over the staged archives,
and uploads the `latest.json` and `latest.json.sig` it writes beside them:
that manifest is what the app's updater (`nsh.json` → `updater`,
`store/update.ts`) reads when it checks for a newer version.

## Incremental (code-package) updates

A release carries two things an install can take: the platform archives — the
whole app — and a signed `.nshpkg` of only the compiled TSX and assets, an
order of magnitude smaller. An install whose `nsh.json` was written with
`updater.packages.roots` prefers the package when its build is newer and the
runtime runs it, downloads it on the card like any update, and restarts into
it; the launcher tries it for a few seconds and goes back to the previous
build if it crashes. Only a release that bumps the runtime or what the
platform reads from the installed app (icon, name, capabilities) needs the
archives — every other update is the package's few megabytes.

The keys live in `keys/` (gitignored, this machine only): `root` certifies
the release key that signs packages, `update` signs the manifest. The public
halves are pinned in `nsh.json` (`updater.packages.roots`,
`updater.publicKey`); the secrets below publish from CI. Keep `root.secret`
offline — whoever holds it can make every install run their code.

| Secret | Content |
| --- | --- |
| `PIPI_PACKAGE_KEY` | `keys/release.secret` — signs the `.nshpkg` |
| `PIPI_PACKAGE_CERT` | `keys/release.cert` — the root's certificate for it |
| `PIPI_UPDATE_KEY` | `keys/update.secret` — signs `latest.json` |

`build` in `nsh.json` is one counter for archives and packages: raise it for
every release of either. An app runs a package only when the package's build
is higher than the build the app shipped with, so a release's package and
archives share the build its `nsh.json` carries. A certificate lasts 365
days: `nsh certify --root keys/root.secret --key keys/release.pub --apps
dev.pipi.app -o keys/release.cert` again before it runs out and update
`PIPI_PACKAGE_CERT`. `nsh verify <pkg> --root keys/root.pub` checks a package
as an install would; `nsh revoke` cuts off a leaked release key or a bad
package.

## Signing configuration

The same Developer ID certificate and team that sign the team's other
apps sign pipi; the secrets live under pipi's own names. Configure these
repository Actions Secrets, and never commit their values:

| Secret | Content |
| --- | --- |
| `PIPI_RELEASE_CERTIFICATE_P12` | base64-encoded P12 including the private key |
| `PIPI_RELEASE_CERTIFICATE_PASSWORD` | P12 export password |
| `PIPI_RELEASE_SIGN_ID` | certificate SHA-1 fingerprint |
| `PIPI_RELEASE_TEAM_ID` | Apple developer team identifier |
| `APPLE_API_KEY_P8` | App Store Connect API private key (PEM) |
| `APPLE_API_KEY_ID` / `APPLE_API_ISSUER` | that key's ID and team issuer ID |

One Developer ID Application certificate signs every app in the team — do not
issue a second one for pipi and do not revoke the shared one (revoking it
breaks the other apps' released builds too). A project-dedicated notarization
key is worthwhile: App Store Connect → Users and Access → Integrations → Team
Keys, Developer role, so it can be revoked without touching the other apps'.

On the runner, `scripts/import-release-signing.mjs` imports the P12 into a
temporary keychain and checks its fingerprint against the pinned
`PIPI_RELEASE_SIGN_ID`; `scripts/install-notary-key.mjs` writes the P8 to
`RUNNER_TEMP` and exports `APPLE_API_KEY` for `notarytool`. An `always()` step
deletes the keychain and both files.

## Local release

On a Mac that already holds the certificate in a keychain:

```sh
export PIPI_RELEASE_SIGN_ID=<sha1 fingerprint>   # security find-identity -v -p codesigning
export PIPI_RELEASE_TEAM_ID=<team id>
export APPLE_API_KEY=$PWD/AuthKey_XXXX.p8        # or wherever the P8 backup lives
export APPLE_API_KEY_ID=<key id>
export APPLE_API_ISSUER=<issuer id>
# or a stored notarytool profile instead of the three APPLE_API_* variables:
# export APPLE_NOTARY_PROFILE=<profile name>
npm run release:macos
```

`release/notarization/submission.json` records the Apple submission before
polling starts; a rerun resumes that submission by archive hash instead of
uploading again. An `UploadUnknown` status means the upload's outcome is ambiguous —
check the submission history in App Store Connect before retrying.

The P12, its password and P8 files stay out of Git and out of logs; `.gitignore`
covers them, but base64 is not encryption and a staged file is already a leak.
