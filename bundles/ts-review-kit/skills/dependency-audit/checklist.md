# Dependency review checklist

A supporting file bundled with the skill. `hcm` copies it verbatim alongside
`SKILL.md`, so the skill keeps working in every harness.

- [ ] Lockfile is committed and in sync with the manifest.
- [ ] No dependency installs from a git URL or a tarball on an unpinned ref.
- [ ] No `postinstall` scripts in newly added packages (or the script is reviewed).
- [ ] New direct dependencies are actually used in the code.
- [ ] Nothing duplicates functionality already available in the standard library.
- [ ] Licences of new dependencies are compatible with this project's licence.
- [ ] Every advisory is triaged as reachable or not reachable, with a reason.
