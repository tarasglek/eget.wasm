# Eget: easy pre-built binary installation

[![Go Report Card](https://goreportcard.com/badge/github.com/zyedidia/eget)](https://goreportcard.com/report/github.com/zyedidia/eget)
[![Release](https://img.shields.io/github/release/zyedidia/eget.svg?label=Release)](https://github.com/zyedidia/eget/releases)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/zyedidia/eget/blob/master/LICENSE)

**Eget** is the best way to easily get pre-built binaries for your favorite
tools. It downloads and extracts pre-built binaries from releases on GitHub. To
use it, provide a repository and Eget will search through the assets from the
latest release in an attempt to find a suitable prebuilt binary for your
system. If one is found, the asset will be downloaded and Eget will extract the
binary to the current directory. Eget should only be used for installing
simple, static prebuilt binaries, where the extracted binary is all that is
needed for installation. For more complex installation, you may use the
`--download-only` option, and perform extraction manually.

![Eget Demo](https://github.com/zyedidia/blobs/blob/master/eget-demo.gif)

For software maintainers, if you provide prebuilt binaries on GitHub, you can
list `eget` as a one-line method for users to install your software.

Eget has a number of detection mechanisms and should work out-of-the-box with
most software that is distributed via single binaries on GitHub releases. First
try using Eget on your software, it may already just work. Otherwise, see the
FAQ for a clear set of rules to make your software compatible with Eget.

For more in-depth documentation, see [DOCS.md](DOCS.md).

# Examples

```
eget zyedidia/micro --tag nightly
eget jgm/pandoc --to /usr/local/bin
eget junegunn/fzf
eget neovim/neovim
eget ogham/exa --asset ^musl
eget --system darwin/amd64 sharkdp/fd
eget BurntSushi/ripgrep
eget -f eget.1 zyedidia/eget
eget zachjs/sv2v
eget https://go.dev/dl/go1.17.5.linux-amd64.tar.gz --file go --to ~/go1.17.5
eget --all --file '*' ActivityWatch/activitywatch
```

# How to get Eget

Before you can get anything, you have to get Eget. If you already have Eget and want to upgrade, use `eget zyedidia/eget`.

### WASI/WASM

A [WASI](https://wasi.dev/) compatible build can be created by running the `./build-wasi.sh` script. This will produce an `eget.wasm` file. This build of `eget` does not perform any network I/O because the Go compiler and most WASI runtimes only support `wasi_snapshot_preview1`, which does not include sockets. Instead, any network requests are translated into filesystem reads from `/tmp`. A request to `scheme://host/path` will be read from `/tmp/scheme/host/path`.

This is useful for running `eget` in sandboxed environments. You will need a WASI-compatible runtime like [wasmtime](https://wasmtime.dev/).

To use the WASI build, you must first build the wasm binary:
```bash
./build-wasi.sh
```

Then, you must manually provide the files `eget` would normally download. For example, to get `getsops/sops`:

Running `eget.wasm` will initially fail because it cannot access the network to get release information:
```bash
$ wasmtime --dir=$PWD::/ eget.wasm --system=linux/amd64 getsops/sops
{"message":"wasm Get","path":"/tmp/https/api.github.com/repos/getsops/sops/releases/latest","url":"https://api.github.com/repos/getsops/sops/releases/latest","error":"open /tmp/https/api.github.com/repos/getsops/sops/releases/latest: No such file or directory"}
```

To fix this, you must download the data and place it in the path that `eget.wasm` expects:
```bash
mkdir -p ./tmp/https/api.github.com/repos/getsops/sops/releases
curl -L https://api.github.com/repos/getsops/sops/releases/latest > ./tmp/https/api.github.com/repos/getsops/sops/releases/latest
```

Then run `eget` with `wasmtime` again. It will read the local file and attempt to find a suitable asset.
Note that you must specify the target system with `--system` because `eget` cannot infer it in a WASI environment. The `-a ^json` argument is used here to filter out asset metadata files.
```bash
$ wasmtime --dir=$PWD::/ eget.wasm --system=linux/amd64 getsops/sops -a ^json
https://github.com/getsops/sops/releases/download/v3.10.2/sops-v3.10.2.linux.amd64
{"message":"wasm Get","path":"/tmp/https/github.com/getsops/sops/releases/download/v3.10.2/sops-v3.10.2.linux.amd64","url":"https://github.com/getsops/sops/releases/download/v3.10.2/sops-v3.10.2.linux.amd64","error":"open /tmp/https/github.com/getsops/sops/releases/download/v3.10.2/sops-v3.10.2.linux.amd64: No such file or directory"}
```
This shows the URL of the asset that `eget` will try to download. Now you must download this asset and place it in the correct path:
```bash
mkdir -p ./tmp/https/github.com/getsops/sops/releases/download/v3.10.2
curl -L https://github.com/getsops/sops/releases/download/v3.10.2/sops-v3.10.2.linux.amd64 > ./tmp/https/github.com/getsops/sops/releases/download/v3.10.2/sops-v3.10.2.linux.amd64
```
Finally, run the command again to extract the binary from the downloaded asset:
```bash
wasmtime --dir=$PWD::/ eget.wasm --system=linux/amd64 getsops/sops -a ^json
```
This will extract `sops` to the current directory.

### Quick-install script

```
curl -o eget.sh https://zyedidia.github.io/eget.sh
shasum -a 256 eget.sh # verify with hash below
bash eget.sh
```

Or alternatively (less secure):

```
curl https://zyedidia.github.io/eget.sh | sh
```

You can then place the downloaded binary in a location on your `$PATH` such as `/usr/local/bin`.

To verify the script, the sha256 checksum is `0e64b8a3c13f531da005096cc364ac77835bda54276fedef6c62f3dbdc1ee919` (use `shasum -a 256 eget.sh` after downloading the script).

One of the reasons to use eget is to avoid running curl into bash, but unfortunately you can't eget eget until you have eget.

### Homebrew

```
brew install eget
```

### Chocolatey

```
choco install eget
```

### Pre-built binaries

Pre-built binaries are available on the [releases](https://github.com/zyedidia/eget/releases) page.

### From source

Install the latest released version:

```
go install github.com/zyedidia/eget@latest
```

or install from HEAD:

```
git clone https://github.com/zyedidia/eget
cd eget
make build # or go build (produces incomplete version information)
```

A man page can be generated by cloning the repository and running `make eget.1`
(requires pandoc). You can also use `eget` to download the man page: `eget -f eget.1 zyedidia/eget`.

# Usage

The `TARGET` argument passed to Eget should either be a GitHub repository,
formatted as `user/repo`, in which case Eget will search the release assets, a
direct URL, in which case Eget will directly download and extract from the
given URL, or a local file, in which case Eget will extract directly from the
local file.

If Eget downloads an asset called `xxx` and there also exists an asset called
`xxx.sha256` or `xxx.sha256sum`, Eget will automatically verify that the
SHA-256 checksum of the downloaded asset matches the one contained in that
file, and abort installation if a mismatch occurs.

When installing an executable, Eget will place it in the current directory by
default. If the environment variable `EGET_BIN` is non-empty, Eget will
place the executable in that directory.

Directories can also be specified as files to extract, and all files within
them will be extracted. For example:

```
eget https://go.dev/dl/go1.17.5.linux-amd64.tar.gz --file go --to ~/go1.17.5
```

GitHub limits API requests to 60 per hour for unauthenticated users. If you
would like to perform more requests (up to 5,000 per hour), you can set up a
personal access token and assign it to an environment variable named either
`GITHUB_TOKEN` or `EGET_GITHUB_TOKEN` when running Eget. If both are set,
`EGET_GITHUB_TOKEN` will take precedence. Eget will read this variable and
send the token as authorization with requests to GitHub. It is also possible
to read the token from a file by using `@/path/to/file` as the token value.

```
Usage:
  eget [OPTIONS] TARGET

Application Options:
  -t, --tag=           tagged release to use instead of latest
      --pre-release    include pre-releases when fetching the latest version
      --source         download the source code for the target repo instead of a release
      --to=            move to given location after extracting
  -s, --system=        target system to download for (use "all" for all choices)
  -f, --file=          glob to select files for extraction
      --all            extract all candidate files
  -q, --quiet          only print essential output
  -d, --download-only  stop after downloading the asset (no extraction)
      --upgrade-only   only download if release is more recent than current version
  -a, --asset=         download a specific asset containing the given string; can be specified multiple times for additional filtering; use ^ for anti-match
      --sha256         show the SHA-256 hash of the downloaded asset
      --verify-sha256= verify the downloaded asset checksum against the one provided
      --rate           show GitHub API rate limiting information
  -r, --remove         remove the given file from $EGET_BIN or the current directory
  -v, --version        show version information
  -h, --help           show this help message
  -D, --download-all   download all projects defined in the config file
  -k, --disable-ssl    disable SSL verification for download
```

# Configuration

Eget can be configured using a TOML file located at `~/.eget.toml` or it will fallback to the expected `XDG_CONFIG_HOME` directory of your os. Alternatively,
the configuration file can be located in the same directory as the Eget binary or the path specified with the environment variable `EGET_CONFIG`.

Both global settings can be configured, as well as setting on a per-repository basis.

Sections can be named either `global` or `"owner/repo"`, where `owner` and `repo`
are the owner and repository name of the target repository (not that the `owner/repo`
format is quoted).

For example, the following configuration file will set the `--to` flag to `~/bin` for
all repositories, and will set the `--to` flag to `~/.local/bin` for the `zyedidia/micro`
repository.

```toml
[global]
target = "~/bin"

["zyedidia/micro"]
target = "~/.local/bin"
```

## Available settings - global section

| Setting | Related Flag | Description | Default |
| --- | --- | --- | --- |
| `github_token` | `N/A` | GitHub API token to use for requests | `""` |
| `all` | `--all` | Whether to extract all candidate files. | `false` |
| `download_only` | `--download-only` | Whether to stop after downloading the asset (no extraction). | `false` |
| `download_source` | `--source` | Whether to download the source code for the target repo instead of a release. | `false` |
| `file` | `--file` | The glob to select files for extraction. | `*` |
| `quiet` | `--quiet` | Whether to only print essential output. | `false` |
| `show_hash` | `--sha256` | Whether to show the SHA-256 hash of the downloaded asset. | `false` |
| `system` | `--system` | The target system to download for. | `all` |
| `target` | `--to` | The directory to move the downloaded file to after extraction. | `.` |
| `upgrade_only` | `--upgrade-only` | Whether to only download if release is more recent than current version. | `false` |

## Available settings - repository sections

| Setting | Related Flag | Description | Default |
| --- | --- | --- | --- |
| `all` | `--all` | Whether to extract all candidate files. | `false` |
| `asset_filters` | `--asset` |  An array of partial asset names to filter the available assets for download. | `[]` |
| `download_only` | `--download-only` | Whether to stop after downloading the asset (no extraction). | `false` |
| `download_source` | `--source` | Whether to download the source code for the target repo instead of a release. | `false` |
| `file` | `--file` | The glob to select files for extraction. | `*` |
| `quiet` | `--quiet` | Whether to only print essential output. | `false` |
| `show_hash` | `--sha256` | Whether to show the SHA-256 hash of the downloaded asset. | `false` |
| `system` | `--system` | The target system to download for. | `all` |
| `target` | `--to` | The directory to move the downloaded file to after extraction. | `.` |
| `upgrade_only` | `--upgrade-only` | Whether to only download if release is more recent than current version. | `false` |
| `verify_sha256` | `--verify-sha256` | Verify the sha256 hash of the asset against a provided hash. | `""` |


## Example configuration

```toml
[global]
    github_token = "ghp_1234567890"
    quiet = false
    show_hash = false
    upgrade_only = true
    target = "./test"

["zyedidia/micro"]
    upgrade_only = false
    show_hash = true
    asset_filters = [ "static", ".tar.gz" ]
    target = "~/.local/bin/micro"
```

By using the configuration above, you could run the following command to download the latest release of `micro`:

```bash
eget zyedidia/micro
```

Without the configuration, you would need to run the following command instead:

```bash
export EGET_GITHUB_TOKEN=ghp_1234567890 &&\
eget zyedidia/micro --to ~/.local/bin/micro --sha256 --asset static --asset .tar.gz
```

# FAQ

### How is this different from a package manager?

Eget only downloads pre-built binaries uploaded to GitHub by the developers of
the repository. It does not maintain a central list of packages, nor does it do
any dependency management. Eget does not "install" executables by placing them
in system-wide directories (such as `/usr/local/bin`) unless instructed, and it
does not maintain a registry for uninstallation. Eget works best for installing
software that comes as a single binary with no additional files needed (CLI
tools made in Go, Rust, or Haskell tend to fit this description).

### Does Eget keep track of installed binaries?

Eget does not maintain any sort of manifest containing information about
installed binaries. In general, Eget does not maintain any state across
invocations. However, Eget does support the `--upgrade-only` option, which
will first check `EGET_BIN` to determine if you have already downloaded the
tool you are trying to install -- if so it will only download a new version if
the GitHub release is newer than the binary on your file system.

### Is this secure?

Eget does not run any downloaded code -- it just finds executables from GitHub
releases and downloads/extracts them. If you trust the code you are downloading
(i.e. if you trust downloading pre-built binaries from GitHub) then using Eget
is perfectly safe. If Eget finds a matching asset ending in `.sha256` or
`.sha256sum`, the SHA-256 checksum of your download will be automatically
verified. You can also use the `--sha256` or `--verify-sha256` options to
manually verify the SHA-256 checksums of your downloads (checksums are provided
in an alternative manner by your download source).

### Does this work only for GitHub repositories?

At the moment Eget supports searching GitHub releases, direct URLs, and local
files. If you provide a direct URL instead of a GitHub repository, Eget will
skip the detection phase and download directly from the given URL. If you
provide a local file, Eget will skip detection and download and just perform
extraction from the local file.

### How can I make my software compatible with Eget?

Eget should work out-of-the-box with many methods for releasing software, and
does not require that you build your release process for Eget in particular.
However, here are some rules that will guarantee compatibility with Eget.

- Provide your pre-built binaries as GitHub release assets.
- Format the system name as `OS_Arch` and include it in every pre-built binary
  name. Supported OSes are `darwin`/`macos`, `windows`, `linux`, `netbsd`,
  `openbsd`, `freebsd`, `android`, `illumos`, `solaris`, `plan9`. Supported
  architectures are `amd64`, `i386`, `arm`, `arm64`, `riscv64`.
- If desired, include `*.sha256` files for each asset, containing the SHA-256
  checksum of each asset. These checksums will be automatically verified by
  Eget.
- Include only a single executable or appimage per system in each release archive.
- Use `.tar.gz`, `.tar.bz2`, `.tar.xz`, `.tar`, or `.zip` for archives. You may
  also directly upload the executable without an archive, or a compressed
  executable ending in `.gz`, `.bz2`, or `.xz`.

### Does this work with monorepos?

Yes, you can pass a tag or tag identifier with the `--tag TAG` option. If no
tag exactly matches, Eget will look for the latest release with a tag that
contains `TAG`. So if your repository contains releases for multiple different
projects, just pass the appropriate tag (for the project you want) to Eget, and
it will find the latest release for that particular project (as long as
releases for that project are given tags that contain the project name).

# Contributing

If you find a bug, have a suggestion, or something else, please open an issue
for discussion. I am sometimes prone to leaving pull requests unmerged, so
please double check with me before investing lots of time into implementing a
pull request. See [DOCS.md](DOCS.md) for more in-depth documentation.
