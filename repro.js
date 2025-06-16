import { eget } from "./eget.js";

async function main() {
  // Example 1 - using no CWD or TO hints
  await eget('getsops/sops', { asset: '^json', verbose: true });

  // Example 2 - using explicit TO hint
  await eget('cli/cli', { verbose: true, to: 'gh-cli' });

  console.log('done')
}

main();
