# Security policy

DRAFT: do not merge until private vulnerability reporting is enabled on this repository (Settings, Code security, "Private vulnerability reporting"). The reporting link below only works after that.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private reporting instead: open the **Security** tab of this repository and choose **Report a vulnerability**. Include what you found, the commit or version, and the smallest steps to reproduce it.

## Scope

This repository contains the Precedent command line tool and GitHub Action. Things that are in scope include:

- handling of the GitHub token and the Anthropic API key (leaks into output, files or logs),
- anything that makes the tool write outside the paths a user gave it (`--out`, `--cache`, `export --out`),
- anything that posts to a pull request without `--post`,
- unsafe handling of repository content that could run code (for example in the Action).

Out of scope: weaknesses in GitHub, Anthropic or other third-party services, and the fact that review comments, guide files and diffs are sent to the model provider as they are (see the README for what is sent).

## Supported versions

Precedent is an early prototype with no tagged releases yet. Only the latest commit on `main` is supported.
