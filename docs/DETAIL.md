# CodeArts Dock

Connect Huawei Cloud CodeArts models to DeepSeek Harness and manage accounts, credits and model preferences.

An unofficial third-party plugin, unaffiliated with Huawei and DeepSeek / Harness operators. You need your own authorized account. Model requests may consume credits or incur charges.

## Features

- Native adapter for streaming text, reasoning, tool calls and model-supported image input.
- Multiple accounts, import/export, manual switching and actionable health checks for all added accounts.
- Local activity history for account changes, settings, check-ins and connection status, with filters and clearing.
- Composer credit chip and multi-account balance overview, retaining clearly marked last results when refreshes fail.
- Model search, capability filters, multiplier sorting and configuration drafts, with context lengths bounded by each model's catalog limit and per-model tests using the current draft. Tests consume a small amount of credits.
- Optional automatic daily check-in, disabled by default, for all added accounts while the plugin is running. Other rewards still require a manual action.
- Manual bulk claim: eligible campaigns are discovered live from the upstream welfare list (daily check-in, Skill contest gifts and any future ones), then claimed for all added accounts. Only campaigns marked claimable upstream and not auto-granted are attempted; certification and other eligibility requirements are determined upstream.

## Get started

Install and enable the bundle, open Settings → CodeArts → Accounts, add your AK/SK, select and save the models you need, then choose a CodeArts model in a conversation.

## Data and costs

Requests and authentication information are sent to the configured services. Local credentials and ordinary account exports are plaintext; protect them and any personal backups of the local configuration directory. Balances and multipliers are not official billing records.

[Documentation](https://github.com/Jensen0925/dsh-codearts-dock#readme) · [Disclaimer](https://github.com/Jensen0925/dsh-codearts-dock/blob/main/DISCLAIMER.md) · [Security](https://github.com/Jensen0925/dsh-codearts-dock/blob/main/SECURITY.md)
