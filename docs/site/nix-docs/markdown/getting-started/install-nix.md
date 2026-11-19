# Install Nix

There are two ways to run Nix: a local development stack for trying it out, and a production deployment with Docker Compose.

## Try it locally

The local stack runs every service on your own machine, with a seeded development account. You need Docker and [mise](https://mise.jdx.dev), which installs the pinned toolchain.

```sh
git clone https://github.com/sianachi/nixsites.git
cd nixsites
mise install
pnpm install --frozen-lockfile
pnpm dev
```

Open [http://localhost:5173](http://localhost:5173) and sign in as `dev@nix.localhost` with the password `nix-dev-password`. These are local development credentials only. `pnpm dev` provisions the development infrastructure, builds the shared packages and starts the API (which runs the background jobs), the collaboration service and the web app. Run `bash scripts/dev.sh --help` to start only some of them.

The local stack is for evaluation and development. Do not expose it to the internet.

## Run it for real

For a deployment you intend to keep, one command installs Nix from the images that CI publishes to the GitHub Container Registry. It needs Docker with at least 1 GB of memory, plus `curl`, `openssl` and `jq`:

```sh
curl -fsSL https://raw.githubusercontent.com/sianachi/nixsites/main/deploy/install.sh | bash
```

Then open `http://nix.localhost`, go to the setup page the script prints and enter the setup code to create the first account, which becomes the administrator. Pass a public https origin to install for real, or `--kubernetes` to install into a cluster; see [Install in one line](nix://item/01a16030-a2fa-76fd-bef3-cb99a1a146d0). You can also run the Docker Compose manifest or the Kubernetes manifests by hand. The [Deployment](nix://item/01a130b0-077c-7b80-9e9e-eb091bb7a0ce) section covers both paths, requirements, configuration, backups and upgrades.

## Install the app on your devices

Nix is a progressive web app. Once your instance is running behind HTTPS, open it in a supported browser and use the browser's install option ("Install app" or "Add to Home Screen").

The installed app gives you:

- launch shortcuts for **New note**, **Today** and **Search**;
- a share target, so you can share text or a link from another app into Nix;
- a Markdown file handler, so `.md` files can open in Nix;
- push notifications for reminders, once you allow them.

Updates arrive as an "An update is ready" prompt. Nix finishes saving pending work before it reloads into the new version.

## Properties

- title: Install Nix

