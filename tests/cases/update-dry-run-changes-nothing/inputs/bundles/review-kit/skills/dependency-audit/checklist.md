# Dependency review checklist

- [ ] Lockfile is committed and in sync with the manifest.
- [ ] No dependency installs from a git URL or an unpinned tarball.
- [ ] New direct dependencies are actually used in the code.
- [ ] Licences of new dependencies are compatible with this project's licence.
- [ ] Every advisory is triaged as reachable or not reachable, with a reason.
