import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const unit = readFileSync(new URL('../../etc/kidcontrol.service', import.meta.url), 'utf8');

describe('systemd network sandbox', () => {
  it('allows netlink so Node can enumerate interfaces for mDNS discovery', () => {
    const restriction = unit.split('\n').find((line) => line.startsWith('RestrictAddressFamilies='));
    expect(restriction?.split(/\s+/)).toContain('AF_NETLINK');
  });

  it('creates the private log directory and appends stdout and stderr to separate files', () => {
    expect(unit).toContain('LogsDirectory=kidcontrol');
    expect(unit).toContain('LogsDirectoryMode=0750');
    expect(unit).toContain('StandardOutput=append:/var/log/kidcontrol/kidcontrol.log');
    expect(unit).toContain('StandardError=append:/var/log/kidcontrol/kidcontrol_error.log');
  });
});
