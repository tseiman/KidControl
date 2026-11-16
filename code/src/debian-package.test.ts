import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('Debian package builder contract', () => {
  it('accepts only amd64 and validates release versions', () => {
    const script = resolve(root, 'scripts/package_release.sh');
    expect(execFileSync(script, ['--validate-version', 'v1.2.0'], { encoding: 'utf8' }).trim()).toBe('1.2.0');
    expect(() => execFileSync(script, ['--validate-version', '1.2.0'])).toThrow();
    for (const invalid of ['v01.2.3', 'v1.2.3-rc.1', 'v1.2.3+build', 'v1.2.3~rc1']) {
      expect(() => execFileSync(script, ['--validate-version', invalid])).toThrow();
    }
    expect(() => execFileSync(script, ['arm64'])).toThrow();
  });

  it('pins and verifies the official Node runtime', () => {
    const script = read('scripts/package_release.sh');
    expect(script).toContain('NODE_VERSION="22.22.3"');
    expect(script).toContain('NPM_VERSION="12.0.2"');
    expect(script).toContain('SHASUMS256.txt');
    expect(script).toContain('sha256sum -c');
    expect(script).toContain('node-v${NODE_VERSION}-linux-x64.tar.xz');
  });

  it('installs the bundled runtime and code at canonical paths', () => {
    const script = read('scripts/package_release.sh');
    expect(script).toContain('/usr/lib/kidcontrol/node');
    expect(script).toContain('/usr/lib/kidcontrol/code');
    expect(script).toContain('Package: kidcontrol');
    expect(script).toContain('Architecture: amd64');
    expect(script).toContain('Depends: adduser, systemd, ca-certificates, libc6, libgcc-s1, libstdc++6');
    expect(script).toContain('/usr/bin/kidcontrol-atv');
    expect(script).toContain('node-appletv-remote/dist/cli/index.js');
  });

  it('keeps the source-install unit intact and rewrites only the packaged unit', () => {
    const script = read('scripts/package_release.sh');
    const unit = read('etc/kidcontrol.service');
    expect(unit).toContain('WorkingDirectory=/opt/kidcontrol/code');
    expect(unit).toContain('ExecStart=/usr/bin/env node --enable-source-maps /opt/kidcontrol/code/dist/main.js');
    expect(script).toContain('WorkingDirectory=/usr/lib/kidcontrol/code');
    expect(script).toContain('ExecStart=/usr/lib/kidcontrol/node/bin/node --enable-source-maps /usr/lib/kidcontrol/code/dist/main.js');
  });

  it('preserves site data and never activates the service automatically', () => {
    const script = read('scripts/package_release.sh');
    expect(script).not.toMatch(/systemctl\s+(enable|start|restart)/);
    expect(script).not.toMatch(/rm\s+-rf\s+\/(etc|var\/lib)\/kidcontrol/);
    expect(script).toContain('refusing symlink');
    expect(script).toContain('install_default_if_missing');
    expect(script).toContain('remove the source-install unit before installing the Debian package');
    expect(script).toContain('require_tracked_source_unchanged');
  });
});

describe('tagged release workflow contract', () => {
  const workflow = read('.github/workflows/release.yml');

  it('runs only for version tags and validates before publishing', () => {
    expect(workflow).toContain('"v[0-9]*"');
    expect(workflow).toContain('npm config set allow-git root --location=project');
    expect(workflow.match(/npm install --global npm@12\.0\.2/g)).toHaveLength(2);
    expect(workflow).toContain('npm ci');
    expect(workflow).toContain('npm test');
    expect(workflow).toContain('npm run build');
    expect(workflow).toContain('npm audit --omit=dev');
    expect(workflow).toContain('bookworm');
    expect(workflow).toContain('trixie');
  });

  it('publishes public deb assets before dispatching apt-repro', () => {
    expect(workflow).toContain('kidcontrol_*.deb');
    expect(workflow).toContain('kidcontrol_*.deb.sha256');
    expect(workflow).toContain('needs: release');
    expect(workflow).toContain('repos/tseiman/apt-repro/dispatches');
    expect(workflow).toContain('Missing repository secret APT_REPO_DISPATCH_TOKEN');
    expect(workflow).toContain('--draft');
    expect(workflow).toContain('gh api --method PATCH');
    expect(workflow).toContain('gh release download');
    expect(workflow).toContain('-F draft=false');
    expect(workflow).toContain('release-manifest.txt');
    expect(workflow).toContain('GITHUB_SHA');
  });
});

describe('operator documentation contract', () => {
  const readme = read('README.md');
  const config = read('config/README_CONFIGURATION.md');

  it('documents the recommended signed APT installation and explicit activation', () => {
    expect(readme).toContain('FBB4 E68D ABB4 A25F 6E73 C81D D4EA 266E 8BC8 043F');
    expect(readme).toContain('apt-get install kidcontrol');
    expect(readme).toContain('systemctl enable --now kidcontrol.service');
    expect(readme).toContain('Do not mix');
  });

  it('documents the packaged pairing CLI path', () => {
    expect(readme).toContain('/usr/bin/kidcontrol-atv companion-pair');
    expect(config).toContain('/usr/bin/kidcontrol-atv companion-pair');
  });
});
