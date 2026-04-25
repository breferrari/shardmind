# Minimal Shard

Static agent-config file for the minimal-shard fixture. Under the v6 contract,
vault-visible Markdown is static content; install-time personalization is done
via dotfolder `.njk` files (e.g. `.claude/settings.json.njk`) or post-install
hooks. The `rendered_files` opt-in for `{{ }}` at vault-visible paths is
deferred to v0.2 (#86).
