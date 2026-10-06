# hcm (built-in bundle)

This bundle ships inside the hcm package. Every hcm installation has it, with
the name `hcm` and the id `0`. You do not register it, and you cannot remove it
from the registry.

| Resource | Flavor | Use |
| --- | --- | --- |
| `context/10-hcm.md` | common | Tells the agent that hcm manages the agent configuration of the project. |
| `skills/hcm-usage/` | common | Find, install, update and remove bundles. |
| `skills/hcm-bundle-authoring/` | `authoring` | Write, check and publish a bundle. |
| `skills/hcm-integration/` | `integration` | Ship a bundle with a CLI tool (`my-cli hcm init`), with a library (`python -m my_library.hcm init`, `npx --no my-lib-hcm init`), or as a separate download. |

## Install

```bash
hcm install hcm -t claude-code                     # all of it
hcm install hcm -t claude-code --flavor authoring  # the common part and the authoring skill
hcm install hcm -t claude-code -s user             # for all projects of this user
```

hcm reads this bundle from the package. After you upgrade hcm, run
`hcm update hcm` in each project that has it.
