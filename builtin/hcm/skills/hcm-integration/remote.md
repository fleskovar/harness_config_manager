# Strategy: a bundle that users download separately

Use this strategy when users must get the bundle without the package. Examples:

- The user works in a different language, or does not install the package.
- The package must stay small, or it cannot contain extra files.
- The bundle changes more often than the package.

Keep the bundle in a folder of your repository, for example `hcm-bundle/`. Tag
each release. Read the shared rules in [the skill](./SKILL.md) first.

## Choose a download method

| Method | Downloads | Repository | Update |
| --- | --- | --- | --- |
| [A. hcm reads GitHub](#a-hcm-reads-github) | An archive of all files of one ref, without history | Public, on GitHub | Register the new tag, then `hcm update` |
| [B. Sparse partial clone](#b-sparse-partial-clone) | Only the bundle folder, without history | Any git host, public or private | `git fetch`, then `hcm update` |
| [C. Release archive](#c-release-archive) | Only the bundle, as one file | Any host that stores release files | Download and extract again, then `hcm update` |

Method A needs only hcm. Use it when the repository is public and small. If the
repository is large, use method B or C, or move the bundle to a small
repository of its own.

## A. hcm reads GitHub

```bash
hcm registry add owner/repo/hcm-bundle#v1.2.0
hcm install my-lib -t claude-code
```

- hcm downloads an archive of the ref `v1.2.0` from GitHub. The archive has all files of that ref, but no git history. hcm keeps only the `hcm-bundle` folder.
- hcm keeps the download in its cache, `~/.hcm/cache`.
- This method works only for public repositories.
- The reference after `#` is a tag, a branch or a commit SHA. If a branch name contains `/`, use this short form, not a `/tree/` URL.

To update to a new release, register the new tag. The entry keeps its id. Then
install the new version into each project:

```bash
hcm registry add owner/repo/hcm-bundle#v1.3.0
hcm update my-lib
```

To follow a branch, register it: `hcm registry add owner/repo/hcm-bundle#main`.
Then each `hcm update my-lib` downloads the latest commit of the branch.

## B. Sparse partial clone

Git can download one folder of a repository. Use git when the repository is
private, when it is not on GitHub, or when it is large. Git uses the
credentials of the user, as for any clone.

```bash
dir="$HOME/.local/share/my-lib/repo"
git clone --depth 1 --filter=blob:none --sparse --branch v1.2.0 https://github.com/owner/repo.git "$dir"
git -C "$dir" sparse-checkout set --no-cone 'hcm-bundle/'
hcm registry add "$dir/hcm-bundle"
```

- `--depth 1` downloads no history.
- `--filter=blob:none` downloads file contents only for the files that git writes to disk. If the server does not support the filter, git downloads all files of the commit. The result is the same.
- `--sparse` and `sparse-checkout set` write only the bundle folder to disk.
- Write the pattern without a `/` at the start. A `/` in the pattern already anchors it to the root of the repository. In Git Bash on Windows, a pattern that starts with `/` becomes a Windows path.
- If your Git does not know `--no-cone`, use `git -C "$dir" sparse-checkout set hcm-bundle`. This cone mode also writes the files at the root of the repository, but not the other folders.
- Register an absolute path, as above. hcm reads a relative path without `./` as a GitHub reference.

To update, get the new ref, then install it into each project. The folder stays
in the same place, so the registration does not change:

```bash
git -C "$dir" fetch --depth 1 origin v1.3.0      # a tag or a branch
git -C "$dir" reset --hard FETCH_HEAD
hcm update my-lib
```

## C. Release archive

Attach the bundle to each release as one archive. In the release job:

```bash
tar -czf my-lib-hcm-bundle.tar.gz -C hcm-bundle .
```

The user extracts the archive into a permanent folder, and registers that
folder:

```bash
dir="$HOME/.local/share/my-lib/hcm-bundle"
rm -rf "$dir" && mkdir -p "$dir"
curl -fsSL https://github.com/owner/repo/releases/download/v1.2.0/my-lib-hcm-bundle.tar.gz | tar -xz -C "$dir"
hcm registry add "$dir"
```

```powershell
$dir = "$HOME\.my-lib\hcm-bundle"
Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $dir | Out-Null
$archive = Join-Path $env:TEMP 'my-lib-hcm-bundle.tar.gz'
Invoke-WebRequest https://github.com/owner/repo/releases/download/v1.2.0/my-lib-hcm-bundle.tar.gz -OutFile $archive
tar -xzf $archive -C $dir
hcm registry add $dir
```

- Windows 10 and later include `tar`.
- For a private GitHub repository, download the file with `gh release download v1.2.0 --repo owner/repo --pattern my-lib-hcm-bundle.tar.gz`.
- Delete the old contents before you extract. Then the files that the new version deleted go too.

To update, run the same commands with the new version, then `hcm update my-lib`.
The folder stays in the same place, so the entry keeps its id.

Some git hosts can also make an archive of one folder of a repository, for
example GitLab with the `path` parameter of its archive API. See the API
documentation of the host.

## Pin the version in a project

A team can record the bundle version in its repository. Put the reference in a
`bundles.txt` file and commit it:

```
# bundles.txt
owner/repo/hcm-bundle#v1.2.0
```

Each developer then runs `hcm import bundles.txt --install -t <harness> --no-prompt`.
To upgrade, change the tag in the file and run the command again. The file
accepts method A references. For methods B and C, give a script that does the
download and the registration.

## Write the instructions for your users

Put the install and update commands in the README of your package. Use the tag
of the release in each command. For method A:

````markdown
## Agent configuration (hcm)

This package comes with agent skills for hcm (harness-config-manager).

Install:

```bash
npm install -g harness-config-manager
hcm registry add owner/repo/hcm-bundle#v1.2.0
hcm install my-lib -t claude-code
```

Update after an upgrade of my-lib:

```bash
hcm registry add owner/repo/hcm-bundle#v<new-version>
hcm update my-lib
```
````

Update the tag in the README in the release step, together with the version of
the package and of the bundle.
