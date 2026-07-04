# Security Policy

## Supported Versions

Security fixes target the current `main` branch until the first tagged release exists.

## Reporting a Vulnerability

Please report suspected vulnerabilities privately to the repository owner. Do not paste secrets, production conversation data, private prompts, private operator material, or raw user data into public issues.

Useful reports include:

- affected version or commit;
- reproduction steps using synthetic data;
- expected and observed fail-closed behavior;
- whether tenant isolation, authorization, idempotency, audit, or secret redaction is affected.

## Security Baseline

VEIL is designed to fail closed for missing auth, tenant mismatch, malformed policy, ambiguous adapter output, and adapter timeout. Public tests cover the core safe-failure paths, but downstream deployments remain responsible for production authentication, secret storage, network policy, and retention controls.
