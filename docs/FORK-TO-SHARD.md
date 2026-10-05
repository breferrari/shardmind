# From an obsidian-mind fork to your own shard

You forked [obsidian-mind](https://github.com/breferrari/obsidian-mind) and made it yours: new folders, other commands, a different `CLAUDE.md`. This guide turns that fork into a shard, so other people can install it with `shardmind install github:<you>/<your-fork>` and take your updates without losing their own edits.

It assumes you know your fork and git. For every file and field in depth, see [`AUTHORING.md`](AUTHORING.md).

## 1. What your fork already is

Since v6.0 (tag `v6.0`), obsidian-mind is itself a shard. Its repo carries a `.shardmind/` folder (`shard.yaml`, `shard-schema.yaml`, `hooks/`) and a `.shardmindignore` at the root. A fork taken from v6.0 or later already has them, under obsidian-mind's identity. A fork taken earlier does not: merge upstream first, then carry on here. If your fork has no `upstream` remote yet, add it with `git remote add upstream https://github.com/breferrari/obsidian-mind`, then run `git fetch upstream && git merge upstream/main`.

The vault content stays where it is. A shard's repo layout is the installed vault's layout ([`AUTHORING.md` §2](AUTHORING.md#2-file-layout)), so nothing moves.

## 2. Give it your identity

Edit `.shardmind/shard.yaml`:

```yaml
apiVersion: v1
name: my-mind               # your repo's name, lowercase and hyphens
namespace: your-github-user # whose repo it is
version: 1.0.0              # your own semver, independent of obsidian-mind's
description: "What your vault is for, in one line"
persona: "Who it is for"
homepage: https://github.com/your-github-user/my-mind
```

Keep `requires` as upstream has it unless you know better: it names the Obsidian, Node and shardmind versions the content and hooks need.

`name`, `namespace` and `version` are what an installed vault records. A user's `shardmind update` then follows **your** releases, not obsidian-mind's.

## 3. Decide what a user answers

`.shardmind/shard-schema.yaml` holds the install questions (`values`), the optional parts a user can leave out (`modules`) and the routing hints (`signals`). Change them to fit your vault ([`AUTHORING.md` §4](AUTHORING.md#4-shard-schemayaml--the-schema)). Two rules matter most:

- **Every value needs a default.** `shardmind install --defaults` must produce exactly what `git clone` of your repo gives (Invariant 1), and the schema parser refuses a value without one.
- **A module is a set of paths.** If you removed a folder that an upstream module listed, remove or edit the module too. `shardmind validate` warns about a module whose paths match nothing.

## 4. Keep, change or drop the hooks

obsidian-mind ships three hooks: `bootstrap` (search index setup), `personalize` (edits from the user's answers) and `post-update`. They are TypeScript, under `.shardmind/hooks/` ([`AUTHORING.md` §6](AUTHORING.md#6-hooks)).

- If your fork still uses qmd search and the same answers, keep them.
- If you changed the values, check that `personalize.ts` reads the ones you kept.
- If you don't need a hook, delete its file and its line under `hooks:` in `shard.yaml`.

Hook output lands in `.shardmind/logs/`, and a vault is often a git repository, so keep `.shardmind/logs/` in the `.gitignore` your fork inherited. `shardmind validate` warns if it's missing.

## 5. Leave repo-only files out of the vault

`.shardmindignore` (gitignore syntax) lists what belongs to the GitHub repo but not to a user's vault: translated READMEs, `CONTRIBUTING.md`, screenshots. Add whatever your fork added for its own GitHub page.

## 6. Check it before anyone installs it

From the fork's directory:

```bash
shardmind validate
```

It runs the install's own checks without installing: the manifest and schema, every module, and a render of every template with your defaults. It never runs your hooks. Then push to a branch and install it for real into an empty folder:

```bash
shardmind install github:your-github-user/my-mind#main --dry-run
shardmind install github:your-github-user/my-mind#main
```

After each push, `shardmind update` in that test vault pulls the branch again. That works because the vault was installed from `#main`: a vault installed from a release follows releases instead ([`AUTHORING.md` §7](AUTHORING.md#7-testing-your-shard-locally)).

## 7. Release it

1. Set `version` in `shard.yaml` (for example `1.0.0`).
2. Tag the commit `v1.0.0`. The tag is `v` plus exactly that version.
3. Publish a **GitHub Release** for the tag, not marked as a prerelease. Without `@version`, install and update choose the latest stable Release, and a repo with none is refused (`NO_RELEASES_PUBLISHED`), even if it has prereleases.

Your users then run:

```bash
shardmind install github:your-github-user/my-mind
```

People who cloned your fork before it was a shard keep their vault and run `shardmind adopt github:your-github-user/my-mind` in it. Adopt compares their files with yours and asks what to keep ([`AUTHORING.md` §1](AUTHORING.md#1-what-is-a-shard)). If you renamed files since the release they cloned, they add `--from-version <that version>` so their edits follow the new paths.

## 8. Keep up with obsidian-mind

Merge upstream into your fork as you do today. When `shard.yaml` conflicts, keep your `name`, `namespace` and `version`, and take upstream's `requires` and `hooks` changes if you use those hooks. Then bump your version, tag and release. Your users' `shardmind update` merges your new release into their own edits with a three-way merge, and asks them only about real conflicts.

If you rename or move a file between releases, declare it under `migrations` in `shard.yaml`, so updating users keep their edits at the new path ([`AUTHORING.md` §3](AUTHORING.md#renaming-a-file-between-releases)):

```yaml
migrations:
  - from: "1.0.0"
    to: "1.1.0"
    renames:
      "brain/Ideas.md": "brain/Inbox.md"
```

## Checklist

- [ ] `.shardmind/` present (merged from obsidian-mind v6.0 or later)
- [ ] `shard.yaml`: your `name`, `namespace`, `version`, `homepage`
- [ ] `shard-schema.yaml`: every value has a default; modules match your folders
- [ ] Hooks kept, adapted or removed; `.shardmind/logs/` in `.gitignore` if any remain
- [ ] `.shardmindignore` covers your repo-only files
- [ ] `shardmind validate` clean, and a test install from a branch works
- [ ] Tag `v<version>` and a GitHub Release
- [ ] Your README tells people: `shardmind install github:<you>/<your-fork>`
