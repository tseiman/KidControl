# KidControl Code

This directory is reserved for the future implementation.

The following decisions are still open:

- the exact Node.js version and SQLite library;
- a framework or an intentionally framework-light WebUI implementation.

KidControl itself will use TypeScript. Apple TV power-state observation is isolated in the separately maintained [`node-appletv-remote`](https://github.com/tseiman/node-appletv-remote) fork and will be consumed as a normal Node.js dependency after hardware validation.

These points will be decided through small, isolated feasibility tests before implementation begins. Product requirements and architecture are documented in [`../docs/README_KIDCONTROL.md`](../docs/README_KIDCONTROL.md).
