# Security Policy

## Supported Versions

Security fixes target the latest v1.x release and the current `main` branch.

## Reporting a Vulnerability

Please report suspected vulnerabilities privately to the repository owner. Do not paste secrets, production conversation data, private prompts, private operator material, or raw user data into public issues.

Useful reports include:

- affected version or commit;
- reproduction steps using synthetic data;
- expected and observed fail-closed behavior;
- whether tenant isolation, authorization, idempotency, audit, or secret redaction is affected.

## Security Baseline

VEIL is designed to fail closed for missing auth, tenant mismatch, malformed policy, ambiguous adapter output, and adapter timeout. Public tests cover the core safe-failure paths, but downstream deployments remain responsible for production authentication, secret storage, network policy, and retention controls.

The v1 production runtime validates JWT issuer, audience, signature algorithm, subject, tenant, and scopes; uses tenant-scoped PostgreSQL queries; persists decision evidence atomically; bounds request bodies; and reports PostgreSQL readiness. Deployers remain responsible for TLS termination, OIDC key lifecycle, database encryption and backups, network policy, retention, monitoring, and incident response.

Decision receipt hashes detect mutation when compared with trusted evidence, but they are not digital signatures and do not provide non-repudiation by themselves.
