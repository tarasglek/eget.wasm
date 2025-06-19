import { test, describe, before, after } from "node:test";
import assert from "node:assert";
import { access, rm, mkdir, readdir, stat } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { Eget, eget, detectSystem } from "../eget.js";

// Timeouts
const STANDARD_TIMEOUT = 30_000;
const E2E_TIMEOUT = 120_000; // Longer for network-dependent tests

// Base directory for all test artifacts
const TEST_BASE_DIR = resolve("./test-tmp");

describe("Eget WASM Node.js Wrapper", () => {
  // Clean up and create the base test directory once before all tests
  before(async () => {
    await rm(TEST_BASE_DIR, { recursive: true, force: true });
    await mkdir(TEST_BASE_DIR, { recursive: true });
  });

  // Clean up the entire test directory after all tests are done
  after(async () => {
    await rm(TEST_BASE_DIR, { recursive: true, force: true });
  });

  // --- Unit Tests ---
  describe("Unit Tests", { timeout: STANDARD_TIMEOUT }, () => {
    test("detectSystem() should return a valid system string", () => {
      const system = detectSystem();
      assert.match(
        system,
        /^(linux|darwin|windows)\/(amd64|arm64|arm)$/,
        "System string should be in 'platform/arch' format",
      );
    });
  });

  // --- Integration Tests ---
  describe(
    "Integration Tests (Eget Class)",
    { timeout: STANDARD_TIMEOUT },
    () => {
      test("Eget constructor should handle options and defaults", () => {
        const customCwd = join(TEST_BASE_DIR, "custom-cwd");
        const customTmp = join(TEST_BASE_DIR, "custom-tmp");

        const instance = new Eget({
          cwd: customCwd,
          tmpDir: customTmp,
          verbose: true,
        });

        assert.strictEqual(instance.cwd, customCwd);
        assert.strictEqual(instance.tmpDir, customTmp);
        assert.strictEqual(instance.verbose, true);
      });

      test("Eget constructor should throw on invalid option types", () => {
        assert.throws(() => new Eget({ cwd: 123 }), TypeError);
        assert.throws(() => new Eget({ tmpDir: {} }), TypeError);
        assert.throws(() => new Eget({ verbose: "true" }), TypeError);
        assert.throws(
          () => new Eget({ onProgress: "not-a-function" }),
          TypeError,
        );
      });

      test("downloadFile() should download a file and report progress", async () => {
        const testDir = join(TEST_BASE_DIR, "download-test");
        await mkdir(testDir, { recursive: true });
        const egetInstance = new Eget({ tmpDir: testDir });

        const url =
          "https://raw.githubusercontent.com/mathiasbynens/small/refs/heads/master/Makefile"; // 2 bytes
        const filePath = join(testDir, "Makefile");
        let progressCalled = false;
        let finalState = { current: 0, total: 0 };

        await egetInstance.downloadFile(
          url,
          filePath,
          (_url, current, total) => {
            progressCalled = true;
            if (current > finalState.current) {
              finalState = { current, total };
            }
          },
        );

        await access(filePath);
        const stats = await stat(filePath);
        assert.strictEqual(stats.size, 2, "File size should be 2 bytes");
        assert.ok(
          progressCalled,
          "onProgress callback should have been called",
        );
        assert.strictEqual(
          finalState.current,
          2,
          "Final progress call should report full size",
        );
      });

      test("downloadFile() should throw on 404 error", async () => {
        const egetInstance = new Eget();
        const url = "https://www.google.com/404";
        const filePath = join(TEST_BASE_DIR, "404.txt");
        await assert.rejects(
          () => egetInstance.downloadFile(url, filePath),
          /HTTP 404/,
          "Should reject with an HTTP 404 error",
        );
      });
    },
  );

  // --- End-to-End Tests ---
  describe("End-to-End Tests (eget function)", { timeout: E2E_TIMEOUT }, () => {
    // Test Case 1: Basic download with onProgress callback
    test("should download sops and call onProgress", async () => {
      const testDir = join(TEST_BASE_DIR, "sops-test");
      let progressCalled = false;
      let lastProgress = { current: -1, total: -1 };

      const success = await eget("getsops/sops", {
        cwd: testDir,
        asset: "^json",
        onProgress: (url, current, total) => {
          progressCalled = true;
          assert.ok(basename(url).includes("sops"), "URL should be for sops");
          lastProgress = { current, total };
        },
      });

      assert.ok(success, "eget() should return true on success");
      await access(join(testDir, "sops"));
      assert.ok(progressCalled, "onProgress callback was not called");
      assert.ok(
        lastProgress.current > 0,
        "Current bytes should be greater than 0",
      );
      assert.strictEqual(
        lastProgress.current,
        lastProgress.total,
        "Final progress should show current equals total",
      );
    });

    // Test Case 2: Renaming output with 'to'
    test("should download gh and rename it using 'to'", async () => {
      const testDir = join(TEST_BASE_DIR, "gh-cli-test");
      const success = await eget("cli/cli", {
        cwd: testDir,
        to: "gh-cli",
        verbose: true
      });

      assert.ok(success, "eget() should return true on success");
      await access(join(testDir, "gh-cli"));
      // Ensure original name doesn't exist
      await assert.rejects(() => access(join(testDir, "gh")));
    });

    // Test Case 3: Extracting a single file from an archive
    test("should download a single file from an archive using 'file'", async () => {
      const testDir = join(TEST_BASE_DIR, "eget-file-test");
      const success = await eget("zyedidia/eget", {
        cwd: testDir,
        file: "eget.1",
      });

      assert.ok(success, "eget() should return true on success");
      await access(join(testDir, "eget.1"));
    });

    // Test Case 4: Extracting all files into a directory
    test("should extract all files into a directory with 'extractAll'", async () => {
      const testDir = join(TEST_BASE_DIR, "nvim-test");
      const outputDir = join(testDir, "nvim-out");
      // Pre-create the target directory as required by eget's logic
      await mkdir(outputDir, { recursive: true });

      const success = await eget("neovim/neovim", {
        cwd: testDir,
        to: "nvim-out",
        extractAll: true,
        asset: "^.sha",
        verbose: true
      });

      assert.ok(success, "eget() should return true on success");
      await access(join(outputDir, "nvim"));
      await access(join(outputDir, "vim.so"));
    });

    // Additional Test: --source flag
    test("should download source code with 'source' flag", async () => {
      const testDir = join(TEST_BASE_DIR, "source-test");
      const success = await eget("stedolan/jq", {
        cwd: testDir,
        extractAll: true,
        source: true,
      });

      assert.ok(success, "eget() should return true on success");
      // Check for a file that is typically in source but not releases
      await access(join(testDir, "build_website.py"));
    });

    // Additional Test: --download-only flag
    test("should download archive without extracting with 'downloadOnly'", async () => {
      const testDir = join(TEST_BASE_DIR, "download-only-test");
      const success = await eget("sharkdp/bat", {
        cwd: testDir,
        downloadOnly: true,
        asset: "linux-gnu.tar.gz",
        system: "linux/amd64",
      });

      assert.ok(success, "eget() should return true on success");
      const files = await readdir(testDir);
      assert.strictEqual(files.length, 1, "Should only be one file");
      assert.ok(
        files[0].endsWith(".tar.gz"),
        "File should be a tar.gz archive",
      );
    });

    // Using a specific tag and extractAll
    test("should download all assets with 'extractAll' flag", async () => {
      const testDir = join(TEST_BASE_DIR, "all-assets-test");
      const outputDir = join(testDir, "output");
      await mkdir(outputDir, { recursive: true });

      const success = await eget("jgm/pandoc", {
        tag: "3.1.9", // Use a specific, small release
        cwd: testDir,
        to: "output",
        asset: ".zip",
        extractAll: true,
        verbose: true
      });

      assert.ok(success, "eget() should return true on success");
      const files = await readdir(outputDir);
      assert.ok(files.length >= 1, "Should download multiple assets");
    });
  });
});
