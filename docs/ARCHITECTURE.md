# Architecture

Phase 06 adds a Node TypeScript proxy bound to `127.0.0.1` that owns Gemini credentials and exposes authenticated, origin-restricted, rate-limited structured analysis. The extension’s `ProviderRouter` is the single cloud-routing choke point: it enforces local-only operation, hybrid fallback, and per-site consent while the options and popup provide proxy configuration, health checks, consent decisions, revocation, and data clearing.
