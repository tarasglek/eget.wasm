import { mkdir } from "fs/promises";
import { basename } from "node:path";
import * as cliProgress from "cli-progress";
import prettyBytes from "pretty-bytes";
import { eget } from "./eget.js";

async function knownToWork() {
  // Example 1 - using no CWD or TO hints, include onProgress callback example
  const progressBar = new cliProgress.SingleBar(
    {
      format:
        "Downloading {filename} | {bar} | {currentSize} / {totalSize} ({percentage}%)",
      hideCursor: true,
    },
    cliProgress.Presets.shades_classic
  );
  const downloadStarted = false;

  await eget("getsops/sops", {
    asset: "^json",
    // Pass a custom onProgress callback function to render info about the download status
    onProgress: function (url, currentBytes, totalBytes) {
      const filename = basename(url);
      const currentSize = prettyBytes(currentBytes);
      const totalSize = prettyBytes(totalBytes);
      if (!downloadStarted) {
        progressBar.start(totalBytes, currentBytes, {
          filename,
          currentSize,
          totalSize,
        });
      } else {
        progressBar.update(currentBytes, { filename, currentSize, totalSize });
      }
    },
  });
  progressBar.stop();

  // Example 2 - using explicit TO hint
  await eget("cli/cli", { verbose: true, to: "gh-cli" });

  // Example 3 - request a specific file
  await eget("zyedidia/eget", { verbose: true, file: "eget.1" });

  // Example 4 - request all files to be extracted, put them in a directory (must exist so eget doesn't assume it's a filename)
  await mkdir("./nvim", { recursive: true });
  await eget("neovim/neovim", { extractAll: true, to: "nvim", verbose: true });

  // Example 5 - request a specific tag
  await eget("zyedidia/micro", {
    verbose: true,
    tag: "nightly",
    asset: "^sha",
  });
}

async function knownToFail() {
  // Doesn't download .tar.gz.sha256 for some reason
  await eget("BurntSushi/ripgrep", { verbose: true });
  // Similar
  await eget("BurntSushi/ripgrep", {
    verbose: true,
    system: "windows/amd64",
    asset: "windows-gnu",
  });

  // Sort of works, but writes the .pkg file for macOS to `./pandoc` which is confusing
  await eget("jgm/pandoc", { verbose: true, asset: "pkg" });
}

async function main() {
  // Allow running good/bad/all examples
  const flag = process.argv[2];

  switch (flag) {
    case "good":
    case "working":
      await knownToWork();
      break;
    case "bad":
    case "fail":
    case "failing":
      await knownToFail();
      break;
    default: {
      await knownToWork();
      await knownToFail();
      break;
    }
  }
}

main();
