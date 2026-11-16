# KidControl releases

This document is for maintainers. Operators should follow the package installation in the project README.

## Release contract

- Release tags are canonical stable `vX.Y.Z` tags on a clean commit. Leading
  zeros, prerelease suffixes, build metadata, and Debian revision suffixes are
  rejected.
- The first release architecture is `amd64`.
- `scripts/package_release.sh amd64` downloads the official Node.js 22.22.3 x64 archive and `SHASUMS256.txt`, verifies the archive, runs the full test/build/audit gates, and creates `kidcontrol_X.Y.Z_amd64.deb` plus its `.sha256` sidecar.
- The package installs code under `/usr/lib/kidcontrol/code`, Node.js under `/usr/lib/kidcontrol/node`, and the unit under `/lib/systemd/system`.
- Configuration and state under `/etc/kidcontrol` and `/var/lib/kidcontrol` are site-owned and preserved.
- Installation never enables, starts, or restarts the service.

## Local candidate verification

Before a tag exists, the explicit test-only override can build the intended version from a dirty implementation tree:

The builder requires Node.js 22.22.3 and npm 12.0.2. GitHub Actions pins both
versions before running it.

```bash
PACKAGE_TEST_MODE=1 \
PACKAGE_ALLOW_DIRTY=1 \
PACKAGE_VERSION_OVERRIDE=v1.2.0 \
./scripts/package_release.sh amd64
./scripts/test_debian_package.sh kidcontrol_1.2.0_amd64.deb
```

The override is rejected unless `PACKAGE_TEST_MODE=1`. Normal release mode rejects a dirty tree and derives the version only from the exact tag at `HEAD`.

## Tagged release

1. Require a clean `main` commit with all tests, build, audit, shell syntax, and package lifecycle checks green.
2. Create and push the exact version tag.
3. The `Tagged release` workflow checks out the tag with full tag history, repeats `npm ci`, tests, build, and production audit, then builds and inspects the package.
4. The package is install/upgrade/remove/reinstall tested in Debian Bookworm and Trixie containers.
5. Only after validation, the workflow uploads and reads back the exact assets
   on a draft GitHub Release, then makes that release public:
   - `kidcontrol_X.Y.Z_amd64.deb`
   - `kidcontrol_X.Y.Z_amd64.deb.sha256`
6. Only after the GitHub Release succeeds, the workflow sends the `apt-release-published` repository dispatch to `tseiman/apt-repro`.

The application repository must contain the Actions secret `APT_REPO_DISPATCH_TOKEN`. The workflow fails explicitly if it is missing. The token value must never be written to Git, logs, release notes, or documentation.

## Post-release verification

Download both release assets over HTTPS, run `sha256sum -c`, and confirm package identity with `dpkg-deb -f`. Then verify the downstream central archive workflow completed and that the signed Bookworm and Trixie indexes contain the released version before recommending an operator upgrade.
