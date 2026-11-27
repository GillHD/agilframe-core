# Contributing to AgilFrame

[Русский](CONTRIBUTING.md) · **English**

For setup questions, start with the documentation. Use the issue forms to report a bug or propose a feature. Report suspected vulnerabilities through the private channel. [Documentation (Russian)](docs/README.md) · [Issue forms](https://github.com/GillHD/agilframe-core/issues/new/choose) · [Security](SECURITY.en.md)

## Issues

- Open one issue per outcome. Name the affected component and describe the observed problem or desired result in the title.
- For bugs, include the version or commit SHA, environment, user roles, reproduction steps through the supported interface, and expected and actual behavior. For user interface issues, include the theme, viewport width, and a redacted screenshot. For multi-node issues, describe the deployment topology.
- For proposals, describe who would use the feature, what they need to do, the proposed outcome, and how to verify it. For API changes, explain compatibility and any required migration.
- Remove tokens, keys, personal data, private URLs, and call content from attachments.

## Code changes

1. Create a short-lived branch from the latest `main`. Use `feature/…` for a feature, `fix/…` for a bug fix, or `docs/…` for documentation. Examples include `feature/room-invites`, `fix/token-expiry`, and `docs/deployment`. Keep each pull request focused on one change.
2. Reuse existing interfaces, access checks, and components. Verify that REST, WebSocket, and configuration changes work with the current SDK and existing stored data.
3. Add a regression test when existing tests would miss the bug. Update the documentation when the workflow changes. Keep build artifacts, caches, and personal tool settings local.
4. Commit under your own GitHub identity using a verified email address or your GitHub-provided no-reply address. Use an imperative subject, for example `Fix token expiry checks`. For substantial changes, use the commit body to explain what changed, why, and how you verified it.

```sh
npm ci
npm run build
npm run typecheck
npm test
node agil/core/scripts/e2e.mjs --only=api
```

List the checks you ran. For browser changes, describe the verification steps and provide evidence of the result. Explain any skipped checks that affect acceptance.

## AI-assisted changes

If an AI tool writes or rewrites a substantial part of a change, identify the affected module and the checks you ran in the pull request. Review the entire diff yourself, including tests and configuration. Check correctness, security, licensing, error handling, and compatibility. You are responsible for the code and should be able to explain it during review. Follow the standard human review process for consequential changes.

## Pull requests and review

- Explain why the change is needed, what users will see, and which checks ran. Use `Fixes #123` when the pull request fully resolves an issue. Mark work in progress as Draft.
- Discuss changes to authorization, data schemas, public APIs, and licensing with a maintainer before submitting. Document compatibility, upgrades, rollback, and limitations.
- Reviewers check the promised behavior, authorization boundaries, backward compatibility, and tests. Resolve blocking feedback and pass applicable CI checks before merging. A generated comment alone does not confirm human review.
- Submit only changes you have the right to contribute. The maintainer checks the necessary rights before commercially relicensing external contributions. [License](LICENSE) · [Notices](NOTICE)
