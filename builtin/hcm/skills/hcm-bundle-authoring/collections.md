# Collections of bundles

A collection is one folder that holds more than one bundle. Usually it is one
repository. `hcm registry add <collection>` registers each bundle in it, and
each bundle keeps its own name, id and version.

A collection can have a collection manifest, `hcm_manifest.yml`, in its root
folder. The manifest holds the data that is the same for all bundles of the
collection. The full syntax is in
[the bundle reference](./reference.md#collection-manifest-hcm_manifestyml).

## When to use a collection

Use a collection when the parts of a kit are useful alone. A user installs and
removes bundles one at a time. Thus, a user can take the review kit without the
database kit.

Use one bundle with flavors when the parts are always used together, and only
the language or the role changes.

## Layout

```
agent-kits/
├── hcm_manifest.yml          # the collection name, and the list of bundle folders
├── README.md                 # not a bundle; hcm ignores it
├── review-kit/
│   └── hcm.yaml
└── db-kit/
    └── hcm.yaml
```

```yaml
# agent-kits/hcm_manifest.yml
collection: acme-agent-kits
bundles:
  - review-kit
  - db-kit
```

- Put each bundle in its own folder, with its own `hcm.yaml`.
- Do not put an `hcm.yaml` in the collection root. hcm refuses a folder that has `hcm.yaml` and `hcm_manifest.yml`.
- Give each bundle a different `name`. The registry has one entry for each name.
- Give each bundle its own `version`. The collection manifest has no version.

## Choose the collection name

hcm records the collection name on each bundle in the registry of the user.
`hcm registry remove --collection <name>` removes all bundles of the
collection in one step.

- Use the name of the repository, the product or the team. Add the organization as a prefix: `acme-agent-kits`, not `kits`.
- Use letters, digits, dots, dashes and underscores. Start with a letter or a digit.
- Do not change the name after you publish the collection. A user keeps the old name until the user registers the collection again. Scripts that use the old name then fail.

A unique name prevents clashes. A clash occurs when the registry of the user
already has the name for bundles from another source. hcm then asks the user to
join that collection, to use another name, or to stop. See
[Name clashes](#name-clashes).

## Decide on the `bundles` list

Without `bundles`, hcm reads each direct subfolder that contains an `hcm.yaml`.
Give a `bundles` list in these conditions:

- The bundles are deeper than one level, for example in `bundles/review-kit`.
- The repository contains bundles that are not for users, for example test data.
- You want a fixed order in the output of hcm.

Each path in the list is relative to the collection root, and must stay inside
it. Each listed folder must contain an `hcm.yaml`. hcm reads only the listed
folders.

## Dependencies between bundles of a collection

hcm finds a dependency in a folder beside the bundle that requires it. Thus:

- Keep a bundle and its dependencies in the same parent folder.
- If the folders have different parents, give a `source` for the dependency. See [Dependencies](./reference.md#dependencies).

## Make a new collection

1. Make the collection folder. In it, make each bundle with `hcm init <bundle-name>`.
2. Write `hcm_manifest.yml` in the collection root. Give a `collection` name. Give `bundles` if a condition above applies.
3. Check all bundles: `hcm validate <collection>`. Fix each problem that it reports.
4. Check the references: `hcm refs check --path <collection>`. Fix each broken reference.
5. Register the collection in place: `hcm registry add <collection> --dev`. If hcm reports a name clash, see [Name clashes](#name-clashes).
6. Make sure that the name is correct: `hcm registry list --collection <name>`. The output must list each bundle.
7. Test each bundle in an empty folder. See [Test a bundle](./SKILL.md#test-a-bundle).
8. Publish the collection. Push it to a repository and tag a version.

Tell users to register the whole collection, for example
`hcm registry add acme/agent-kits#v1.0.0`. A bundle that a user registers from
its own folder gets no collection name.

## Add a manifest to an existing collection

Use this procedure for a folder or repository that already ships more than one
bundle, but has no `hcm_manifest.yml`.

1. Make sure that hcm reads collection manifests. Run `hcm registry add --help`. The output must show `--collection`. If not, tell the user to upgrade hcm.
2. Find the bundles. List each folder in the collection that contains an `hcm.yaml`. Look deeper than one level.
3. Make sure that the collection root has no `hcm.yaml`. If it has one, the folder is one bundle, not a collection. Stop and ask the user.
4. Ask the user which bundles are for distribution. Do not include test data or examples.
5. Choose the collection name. See [Choose the collection name](#choose-the-collection-name).
6. Run `hcm registry list`. If another source already uses the name, choose a different name, or ask the user.
7. Write `hcm_manifest.yml` in the collection root. Give `collection`. Give `bundles` if the bundles are deeper than one level, or if some folders are not for distribution.
8. Check the result: `hcm validate <collection>`. The output must list each bundle for distribution, and no other bundle.
9. Do not change the version of a bundle for this change. The manifest does not change the content of a bundle.
10. Commit `hcm_manifest.yml`. For a remote collection, tag a new version of the repository.

### Update the registry after the retrofit

hcm records the collection name when it registers the collection.
`hcm registry update` does not read the collection manifest. Thus, register the
collection again:

```bash
hcm registry add <collection>                 # snapshot entries
hcm registry add <collection> --dev           # entries that read the folder in place
hcm registry list --collection <name>         # check: each bundle shows the name
```

- A second registration keeps the id of each bundle. Installed bundles do not change.
- `--dev` applies to all bundles of the command. If only some entries are `--dev` entries, register those bundles one at a time: `hcm registry add <collection>/<bundle> --dev --collection <name>`. A folder inside the collection is not a clash.
- For a remote source, for example `owner/repo#v1.0.0`, give that source again with the new tag.

Tell the users of a published collection to register the collection again
with the new tag. Give them the command.

## Name clashes

A clash occurs when a registration asks for a collection name, and bundles of
a different source already have that name. hcm asks the user what to do:

| Choice | Result |
| --- | --- |
| `join` | The new bundles go into the existing collection. `hcm registry remove --collection` then removes both groups. |
| `rename` | The new bundles go into a collection with another name, for example `<name>-2`. hcm records the rename. A later registration of the same source gets the same name, with no question. |
| `abort` | hcm registers nothing. |

These cases are not clashes:

- The source already has bundles in the collection.
- The sources differ only in the ref, for example `#v1.0.0` and `#v1.1.0`.
- One source is inside the other, for example a collection folder and one of its bundle folders.
- The only bundles with the name are bundles that the registration replaces.

An agent has no terminal, so hcm cannot ask. hcm then stops, registers nothing,
and names the bundles that have the name. Do these steps:

1. Tell the user which source already uses the name.
2. Ask the user to choose `join`, `rename` or `abort`.
3. Run the command again with `--on-collection-clash <choice>`.

Do not choose `join` without the consent of the user. After a join, one removal
command removes the bundles of both sources.

## A collection that you cannot change

A user can name a collection that has no manifest. Give the name on the command
line:

```bash
hcm registry add acme/agent-kits#v1.0.0 --collection acme-agent-kits
```

`--collection` also replaces the name of a collection manifest.
