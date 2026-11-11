# The project requirements file

A requirements file lists the bundles that one project uses. The file is part
of the project, and goes into version control with it. Each person who has hcm
then installs the same bundles with one command.

The default file name is `hcm-requirements.txt`, in the project root. The
syntax follows the direct references of the `requirements.txt` file of pip.

```
# hcm-requirements.txt
review-kit @ https://github.com/acme/agent-kits.git@v2.0.0
db-kit     @ https://dev.azure.com/acme/platform/_git/kits@v1.4.0
py-kit     @ git+ssh://git@github.com:acme/agent-kits.git@main --flavor python
docs-kit   @ ./agents
team-kit
```

## Choose the correct file

| File | Use it when | Command |
| --- | --- | --- |
| `hcm-requirements.txt` | The bundles belong to one project. Each person who works on the project must get them. | `hcm install -r` |
| `bundles.txt` | One user wants the same registry on another machine. | `hcm import bundles.txt --install` |
| No file | One project pins one bundle, and nobody else installs it. | `hcm install <source> --track source` |

A requirements file does not change the registry. It installs into the project
only.

## Install the bundles of a project

Do these steps when a project has an `hcm-requirements.txt` file, or when the
user asks you to install the bundles of the project.

1. Read the file. Find the lines with no source. Each of them needs a registered bundle of that name. Run `hcm registry list` to make sure that the bundle is there.
2. Preview the install: `hcm install -r -t <harness> --no-prompt --dry-run`.
3. Read the plan. If hcm reports errors, see [When the install fails](#when-the-install-fails).
4. Install: `hcm install -r -t <harness> --no-prompt`.
5. Check the result: `hcm status`.

For a file with a different name or in a different folder, give its path:
`hcm install -r tools/agents.txt -t <harness> --no-prompt`.

Rules:

- Do not give bundle names and `-r` in one command. hcm refuses the command.
- Do not give `--track`. A line with a source follows that source. A line with no source follows the registry.
- The command-line options apply to each line. An option on a line replaces the same command-line option for that bundle.
- hcm reads all lines and downloads all sources first. If one line has an error, hcm installs nothing.
- One set of answers applies to the whole file. A conflict question or a parameter question comes one time only.
- Each run downloads the sources again. A line with a branch then gets the latest commit of the branch.
- You can run the command again at any time. A bundle that did not change installs the same items again.

### Private repositories

| Source | What the user must do |
| --- | --- |
| HTTPS URL of a host other than github.com | Set an access token in `HCM_GIT_TOKEN`, or in `HCM_GIT_TOKEN_<HOST>`, for example `HCM_GIT_TOKEN_DEV_AZURE_COM`. |
| `git+https://github.com/...` | Set a GitHub token in `HCM_GIT_TOKEN`, or in `HCM_GIT_TOKEN_GITHUB_COM`. |
| `https://github.com/...` with no `git+` | Nothing is possible. This form reads only public repositories. Change the line to `git+https://` or `git+ssh://`. |
| SSH URL | Install git. Make sure that `git ls-remote <url>` works in the terminal of the user. |

Do not put a token in the file. hcm refuses a URL that contains a password.
Ask the user to set the variable. Do not set it yourself.

## Write a requirements file

Do these steps when the user asks you to make the project install the same
bundles for each person.

1. For each bundle, find its source: the repository, or the folder in the project.
2. Find the bundle name. It is the `name` in the `hcm.yaml` of the bundle, not the folder name. To list the names of the bundles in a source, see [Find the bundle names](#find-the-bundle-names).
3. Choose a ref for each remote source. See [Choose the ref](#choose-the-ref).
4. Write one line for each bundle. Do not write a line for a bundle that the project does not use.
5. Add `--flavor`, `--target` or `--param` to a line only when that bundle needs it.
6. Save the file as `hcm-requirements.txt` in the project root.
7. Preview: `hcm install -r -t <harness> --no-prompt --dry-run`. Fix each error that hcm reports.
8. Tell the user to commit the file. Also tell the user about the tokens or SSH access that each person needs.

To make a file from the bundles that are already installed, run
`hcm list --installed --json`. Each record has the `bundle`, its `source` and
its `flavors`. Write one line for each bundle. Do not write a line for a record
with `"auto": true`. hcm installed that bundle only because another bundle
requires it.

### The line

```
<bundle> @ <source>[@ref][#subdirectory=<folder>] [options]   # comment
<bundle> [options]                                            # comment
```

- `<bundle>` is the name in the manifest of the bundle. Use letters, digits, dots, dashes and underscores.
- Spaces around the `@` are optional.
- A line with no source installs the registered bundle of that name.
- `#` starts a comment, at the start of a line or after a space. A `#` in a URL is not a comment.
- Put a value that contains spaces in quotes: `--param TEAM="Platform team"`.
- Each bundle name can occur on one line only.

### The source

| Source | Example | hcm downloads it with |
| --- | --- | --- |
| GitHub, HTTPS | `https://github.com/acme/kits.git@v1.0.0` | The GitHub archive. Public repositories only. |
| GitHub, git protocol | `git+https://github.com/acme/kits.git@v1.0.0` | The git protocol over HTTPS. |
| Azure DevOps, HTTPS | `https://dev.azure.com/acme/platform/_git/kits@v1.0.0` | The git protocol over HTTPS. |
| Other git host, HTTPS | `https://gitlab.com/acme/kits.git@v1.0.0` | The git protocol over HTTPS. |
| SSH, URL form | `git+ssh://git@github.com/acme/kits.git@main` | The `git` program, with the SSH keys of the user. |
| SSH, scp-like form | `git@ssh.dev.azure.com:v3/acme/platform/kits@main` | The `git` program, with the SSH keys of the user. |
| A folder | `./agents`, `../shared/kits`, `/opt/kits`, `file:///opt/kits` | Nothing. hcm reads the folder in place. |

- A relative folder starts in the folder of the requirements file, not in the current folder.
- A source can hold many bundles. hcm installs only the bundle that the line names.
- hcm finds the bundle by its name. It searches the root of the source and the folders below it, to a depth of four folders.
- If the source has two bundles with the same name, add `#subdirectory=<folder>` to the source. The folder is relative to the root of the repository.
- Use an HTTPS URL when the users have tokens and possibly no git. Use an SSH URL when the users have SSH keys for the host.

### Choose the ref

The ref follows the last `@` of the URL. An `@` before the host is a user name,
not a ref: `https://acme@dev.azure.com/...` and `git@github.com:...`.

| Ref | Example | Result |
| --- | --- | --- |
| A tag | `@v1.2.0` | Each person gets the same version. Use a tag when you can. |
| A full commit id | `@3f2a9c1e...` (40 characters) | Each person gets the same version, also when somebody moves a tag. |
| A branch | `@main`, `@release/2` | Each run gets the latest commit of the branch. Two people can get different versions. |
| No ref | | The default branch, with the same result as a branch. |

A folder source has no ref. It gives the files that are in the folder now.

### The options of a line

| Option | Meaning |
| --- | --- |
| `--flavor <flavor...>`, `-f <flavor...>` | Install the common part of the bundle and these flavors. To see the flavors, run `hcm info <bundle>`. |
| `--target <harness...>`, `-t <harness...>` | Install this bundle into these harnesses only. |
| `--param NAME=value` | Set a parameter of this bundle. Give the option one time for each parameter. hcm applies it to this bundle only, not to its dependencies. |

`--flavor` and `--target` take all values until the next option. Put a
comment after the options, not between them.

### Find the bundle names

Use one of these methods:

- Read the `hcm.yaml` of each bundle in the repository, and find the `name`.
- Run `hcm info <source>`. For a collection, the output shows each bundle.
- Write a line with a name that you think is correct, and run `hcm install -r --dry-run`. If the name is not correct, hcm lists the names of the bundles in that source: `Bundles there: alpha, beta`.

## Change the file

| Task | Do this |
| --- | --- |
| Use a new version of a bundle | Change the ref on its line. Run `hcm install -r -t <harness> --no-prompt`. |
| Add a bundle | Add a line. Run `hcm install -r -t <harness> --no-prompt`. |
| Change the flavors of a bundle | Change `--flavor` on its line. Run `hcm install -r -t <harness> --no-prompt`. hcm removes the items of the old flavors. |
| Remove a bundle | Delete its line. Then run `hcm uninstall <bundle> -t <harness>`. hcm does not remove a bundle only because its line is gone. |
| Get the latest commits of the branches | Run `hcm install -r -t <harness> --no-prompt` again. `hcm update -t <harness> --no-prompt` also reads the recorded branch of each bundle. |

After a change, preview with `--dry-run` first. Then tell the user to commit
the file.

## When the install fails

hcm reports each error with the line number. Fix all of them, then run the
command again.

| hcm reports | Cause | Do this |
| --- | --- | --- |
| `No such file: .../hcm-requirements.txt` | The file is not in the current folder. | Run the command in the project root, or give the path after `-r`. |
| `"<name>" is also on line <n>` | Two lines name the same bundle. | Delete one of the lines. |
| `"<option>" is not an option of a requirements line` | The line has an option that a requirements file does not take. | Use only `--flavor`, `--target` and `--param` on a line. Give the other options on the command line. |
| `"#..." is not a fragment that hcm reads` | The URL has a `#ref:folder` fragment, which is the form of `hcm registry add`. | Put the ref after `@`. Put the folder in `#subdirectory=<folder>`. |
| `There is no bundle "<name>" in <source>` | No manifest in the source has that name. | Use a name from the `Bundles there:` list. If the bundle is more than four folders deep, add `#subdirectory=<folder>`. |
| `<source> has <n> bundles named "<name>"` | The name is not unique in the source. | Add `#subdirectory=<folder>` with one of the folders that hcm lists. |
| `gives no source, and no bundle of that name is registered` | The line has no source, and the registry of this machine does not have the bundle. | Ask the user for the source. Add it to the line, or register the bundle with `hcm registry add`. |
| `git could not read <url> at <ref>` | The SSH access failed, or the ref does not exist. | Ask the user to run `git ls-remote <url>`. If that works, check the ref. |
| `An SSH or git:// URL needs the git program` | Git is not installed, or it is not on the PATH. | Ask the user to install git, or change the line to an HTTPS URL. |
| An HTTP status, or a message about a token | The repository is private, and no token is set. | See [Private repositories](#private-repositories). |
| `Give bundle names or -r, not both` | The command has bundle names and `-r`. | Run two commands. |
| `--track does not apply to -r` | The command has `--track`. | Remove `--track`. |
