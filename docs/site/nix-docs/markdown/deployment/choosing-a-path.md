# Choosing a path

# Choosing a path

Both paths run the same images and the same database schema. They differ in what they include, how they are operated and how much the release tooling does for you.

|  | Docker Compose | Kubernetes |
| --- | --- | --- |
| Status in the repository | The default target | Kept for an explicit switch: the scripts refuse to run unless NIX\_DEPLOY\_TARGET=kubernetes is set |
| Manifest | deploy/compose.prod.yml | deploy/k8s/\*.yaml, applied by deploy/k8s/deploy.sh |
| Cluster or host | One Linux machine with Docker Engine and Compose v2 | Any cluster with an ingress controller and a StorageClass; k3s with Traefik behind Cloudflare by default |
| Sign-in | Nix signs people in itself; an outside OpenID Connect provider is optional | The same |
| Background jobs | Run inside Core | Run inside Core |
| Node service | One nix-node container (collaboration, companion, and the sites worker when sites are on) | One nix-node pod with all three roles |
| Sites | Optional, through the sites profile | Included; sites are served at \<slug>.\<your-domain> |
| Public ingress | Caddy with automatic HTTPS (installer), a Cloudflare Tunnel connector, or your own reverse proxy | Your ingress controller; by default Traefik Ingresses that admit only Cloudflare's edge, with an origin certificate |
| Releases | deploy/install.sh --version, or deploy/compose/release.sh: image checks, backup, migrations, smoke test and a release ledger | deploy/install.sh --kubernetes --version, or deploy/k8s/deploy.sh, which applies everything in order; deploy/k8s/verify.sh checks it |
| Backups | deploy/compose/backup.sh with a restore test, plus encrypted off-site copies | A nightly CronJob writes dumps and a storage archive to a volume on the same node |
| Network isolation | One private Compose network | NetworkPolicies limit who may reach the object store and where the node service and the sites server may connect |

## When to choose which

Choose **Docker Compose** if you want the most complete release tooling, or want the simplest thing to reason about at 2am. It is the path with verified backups and an automated smoke test.

Choose **Kubernetes** if you already run a cluster, want Sites deployed alongside Nix in one step, and are happy to arrange off-node backup copies yourself. The manifests are sized to fit a small single node: one replica of each service and modest memory limits.

Either way, keep the rules that apply to both: run images by release tag or full commit SHA, take a backup before every upgrade, and never let a migration and an old image run against each other.

## Properties

- title: Choosing a path

