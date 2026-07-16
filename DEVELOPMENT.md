# Development

## Local setup

```bash
npm install
npm run test:all
pi install /absolute/path/to/pi-plan-exec
```

Reload Pi after changing the extension:

```text
/reload
```

## Validation

```bash
npm run lint
npm run check
npm test
npm run pack:dry
```

`npm run test:all` is the local gate used by CI and the release workflow.
`npm run pack:dry` checks the final npm tarball against a runtime-only allowlist;
the release workflow checks npm before it performs an actual publish.

## Release

Target package:

```text
@alexeiled/pi-plan-exec
```

Normal releases are tag-driven. Decide patch versus minor first, update
`package.json`, `package-lock.json`, and `CHANGELOG.md`, then commit the release
version before tagging:

```bash
npm run test:all
git commit -am "chore: release <version>"
git tag v<version>
git push origin main --follow-tags
```

Use `npm version patch` or `npm version minor` only when it is the command that
makes the intended version change; do not bump an already versioned release a
second time.

The release workflow runs only for pushed `v*` tags. It rejects a tag that does
not match `package.json` or is not on `main`, runs the validation gate, publishes
with npm provenance, and creates a GitHub Release.

### Trusted publishing

The workflow uses GitHub Actions OIDC, not `NPM_TOKEN`. It needs:

- a GitHub-hosted runner;
- `id-token: write` in `.github/workflows/release.yml`;
- an npm trusted publisher tied to `alexei-led/pi-plan-exec` and `release.yml`;
- the `repository.url` in `package.json` to exactly match the GitHub repository.

npm cannot configure a trusted publisher until the package already exists. The
initial release therefore needs one authenticated local publish, then a one-time
trust configuration. The exact bootstrap commands are supplied during release
setup; do not add an npm token to GitHub secrets.

After trusted publishing is configured, future releases must go through pushed
version tags. Do not run local `npm publish` again.
