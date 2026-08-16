# Provider settings storage

GitNexus remembers LLM provider settings, including API keys and custom provider
endpoints, in the current browser profile by default. This lets a configured
provider remain available after the GitNexus tab closes and reopens.

## Controls

The **Remember API keys on this device** option in AI Settings controls the
behavior. It is enabled by default.

- When enabled, settings are written to both `sessionStorage` and
  `localStorage`. On startup, the durable copy restores the active provider and
  is mirrored into the new tab session.
- When disabled and saved, the durable settings record is deleted immediately.
  The current tab retains its session settings until it closes.
- Resetting provider settings clears both setting records while keeping the
  selected persistence preference.

## Security boundary

The browser stores these settings locally and GitNexus only sends an API key to
the configured LLM provider when a chat request is made. The persistence logic
does not add a server request, telemetry, or key synchronization path.

Browser `localStorage` is not encrypted application storage. Anyone who can
access the same browser profile on this device may be able to read remembered
keys. Disable remembering on shared computers or browser profiles.
