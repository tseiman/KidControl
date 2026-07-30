# KidControl

KidControl is intended to provide time-controlled network access for wired Apple TVs through the official UniFi Network API and existing ACL rules. Users start and stop usage from a smartphone-optimized WebUI, while daily time budgets are tracked across devices.

## Status

Planning phase — requirements and architecture are documented. TypeScript on Node.js and a separate `node-appletv-remote` fork have been selected; the remaining runtime and WebUI details will be finalized before coding begins.

## Planned Prerequisites

- Debian 12 or 13
- access to a UniFi Console with the Network Integration API and an API key
- one tested UniFi ACL rule per Apple TV
- TypeScript on Node.js as the web/server runtime; the exact Node.js version and SQLite integration are still open
- the maintained [`node-appletv-remote`](https://github.com/tseiman/node-appletv-remote) fork for Companion Link power-state monitoring

## Documentation

- [Requirements, architecture, and open decisions](docs/README_KIDCONTROL.md)
- [Placeholder for the future implementation](code/README_CODE.md)

The WebUI will display the Markdown file stored in `docs/` as HTML. The deployment process must copy the file into the documentation server's content directory.

## Security

UniFi API keys must not be stored in the repository. The application will read the key exclusively from protected runtime configuration or an environment variable.

## License

[MIT](LICENSE)
