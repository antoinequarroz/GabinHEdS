# GabinHEdS

The new studio application lives in `studio/`. The legacy `desktop-app/` and
`gabinOneclick/` directories are references only; do not run their installation
or launch scripts when working on the new version.

## Development servers

- Always use Portly (`portly ...`) to start, stop, restart, inspect, or keep local development servers running.
- Start with `portly status`. Use `portly status --details` only for the full inventory and metrics, and `--json` only for machine-readable fields. Reuse a healthy managed server; if an in-scope server is running outside Portly, register it and use `portly take-over <project/server> --json`.
- For long-lived or reusable work, create a project and server.
- For builds, tests, code generation, previews, demos, and other bounded one-off work, run `job_id="$(portly temp '<command>' --path <folder> --timeout 30m)"`, then `portly wait "$job_id"`. `temp` returns immediately with an ID; `wait` prints captured logs and exits with the command's real code. A timeout kills the whole process group and exits with code `124`.
- Never launch persistent development servers directly, in the background, or through another supervisor.
- On this Mac, if Portly is absent from PATH, use `/Applications/Portly.app/Contents/Resources/portly-cli`.

## Implementation

- Use the shared API contracts in `studio/packages/shared/src/index.ts`.
- Confirm recording state with OBS; never display a simulated success as a real recording.
- All PC, iPad, and Stream Deck control goes through the same authenticated API.
- Preserve existing local changes and never commit runtime databases, recordings, passwords, or device tokens.
