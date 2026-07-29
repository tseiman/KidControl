# KidControl

KidControl is intended to provide time-controlled network access for wired Apple TVs through the official UniFi Network API and existing ACL rules. Users start and stop usage from a smartphone-optimized WebUI, while daily time budgets are tracked across devices.

## Status

Planning phase — requirements and architecture are documented. The runtime and implementation details will be selected before coding begins.

## Planned Prerequisites

- Debian 12 or 13
- access to a UniFi Console with the Network Integration API and an API key
- one tested UniFi ACL rule per Apple TV
- Node.js as the preferred web/server runtime; the exact version and SQLite integration are still open
- optionally, Python with `pyatv` for detecting the Apple TV sleep state

## Documentation

- [Requirements, architecture, and open decisions](docs/README_KIDCONTROL.md)
- [Placeholder for the future implementation](code/README_CODE.md)

The WebUI will display the same Markdown file stored in `docs/` as HTML. A relative symlink under `code/public/docs/` avoids maintaining an error-prone second copy.

## Security

UniFi API keys must not be stored in the repository. The application will read the key exclusively from protected runtime configuration or an environment variable.

## License

[MIT](LICENSE)
