import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const scriptUrl = new URL('../../update.sh', import.meta.url);
const scriptPath = scriptUrl.pathname;
const script = readFileSync(scriptUrl, 'utf8');

function position(fragment: string): number {
  const index = script.indexOf(fragment);
  expect(index, `missing script fragment: ${fragment}`).toBeGreaterThanOrEqual(0);
  return index;
}

describe('production update script', () => {
  it('is executable Bash with side-effect-free help', () => {
    expect(statSync(scriptUrl).mode & 0o111).not.toBe(0);
    expect(script).toMatch(/^#!\/usr\/bin\/env bash\n/);
    expect(spawnSync('bash', ['-n', scriptPath], { encoding: 'utf8' }).status).toBe(0);
    const help = spawnSync(scriptPath, ['--help'], { encoding: 'utf8' });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('Usage: ./update.sh [--yes]');
  });

  it('checks the checkout and production prerequisites', () => {
    expect(script).not.toContain('EUID == 0');
    expect(script).toContain('git status --porcelain');
    expect(script).toContain('git pull --ff-only');
    expect(script).toContain('Node.js >=22.12.0');
    expect(script).toContain('systemd-analyze verify');
    expect(script).toContain('sudo -v');
    expect(script).toContain('/etc/kidcontrol/config.json');
    expect(script).toContain('/var/lib/kidcontrol');
    expect(script).toContain('test ! -L "$INSTALL_ROOT"');
  });

  it('tests, builds, audits, and checks the revision before stopping production', () => {
    const test = position('npm test');
    const build = position('npm run build');
    const audit = position('npm audit --omit=dev');
    const revision = position('dist/version.txt');
    const stop = position('sudo systemctl stop "$SERVICE"');
    expect(test).toBeLessThan(build);
    expect(build).toBeLessThan(audit);
    expect(audit).toBeLessThan(stop);
    expect(revision).toBeLessThan(stop);
  });

  it('waits for startup and verifies the revision in the current journald invocation', () => {
    expect(script).not.toContain('/var/log/kidcontrol');
    expect(script).not.toContain('LOG_LINES_BEFORE_START');
    expect(script).toContain('InvocationID');
    expect(script).toContain('_SYSTEMD_INVOCATION_ID="$INVOCATION_ID"');
    expect(script).toContain('for _attempt in {1..10}');
    expect(script).toContain('sleep 2');
    expect(script).toContain('KidControl version $REVISION');
    expect(script).toContain('JOURNAL=$(sudo journalctl');
  });

  it('limits replacement to generated code and verifies the restarted service', () => {
    expect(script).toContain('sudo rm -rf -- "$INSTALL_ROOT/dist" "$INSTALL_ROOT/node_modules"');
    const copy = position('sudo cp -a code/dist code/node_modules code/package.json code/package-lock.json "$INSTALL_ROOT/"');
    const ownership = position('sudo chown -R root:root /opt/kidcontrol');
    const permissions = position('sudo chmod -R u=rwX,go=rX "$INSTALL_ROOT/dist" "$INSTALL_ROOT/node_modules"');
    const sourceMapVerification = position('sudo -u kidcontrol /usr/bin/env PATH=/usr/local/bin:/usr/bin:/bin node "$INSTALL_ROOT/dist/verify-source-maps.mjs" "$INSTALL_ROOT/dist"');
    const start = position('sudo systemctl daemon-reload\nsudo systemctl start "$SERVICE"');
    expect(copy).toBeLessThan(ownership);
    expect(ownership).toBeLessThan(permissions);
    expect(permissions).toBeLessThan(sourceMapVerification);
    expect(sourceMapVerification).toBeLessThan(start);
    expect(script).toContain('dist/version.txt');
    expect(script).toContain('dist/main.js.map');
    expect(script).toContain('sudo test -f "$INSTALL_ROOT/dist/main.js.map"');
    expect(script).toContain('$INSTALL_ROOT/dist/version.txt');
    expect(script).toContain('systemctl is-active --quiet "$SERVICE"');
    expect(script).toContain('KidControl version $REVISION');
    expect(script).toContain('trap restart_after_failure EXIT');
  });
});
