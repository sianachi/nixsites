# Images and tags

# Images and tags

CI builds Nix's images in `.github/workflows/ci-images.yml` on every push to `main`, and on demand.

| Image | Contents |
| --- | --- |
| api | Core |
| migrator | Core's database migrations |
| collab | The collaboration service, and its document migration command |
| worker | The Go worker binary for every role |
| web | The web app and Caddy |
| sites | The sites build worker and the sites serving process |
| release-tools | nixctl and the release smoke test, so the host needs no Node |

## Tags

Every image is tagged with the full 40-character commit SHA it was built from, and published as `ghcr.io/<owner>/nix/<image>:<full-commit-sha>`. Pushing a release tag `vX.Y.Z` gives that commit's images two more names, `vX.Y.Z` and `latest`, without a rebuild; the installer uses `latest` by default and `--version` pins either form. A deployment still names exactly one commit, and the manifest and scripts you run must come from that same commit.

## Architectures

Each image is built natively on an `amd64` runner and an `arm64` runner, and the two are joined into one multi-architecture manifest. The same tag runs on an x86 server and on an ARM board.

## Rebuilding only what changed

A planning step works out which images' inputs changed in a commit. Only those are rebuilt; the others are re-tagged from the previous build with the new SHA, so every commit still has a complete set.

## Building your own

You do not need to build images to run Nix. If you want to, `deploy/compose/build.sh <ref>` builds local images from a clean `git archive` of a commit for use with `NIX_IMAGE_REGISTRY=localhost/nix`, and `deploy/docker/build-and-push.sh` builds and pushes all seven to your own registry for Kubernetes. Do not build images on a production host as a routine release step.

## Properties

- title: Images and tags

