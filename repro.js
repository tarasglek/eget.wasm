import { eget } from "./eget.js";

async function main() {
  await eget('getsops/sops', { quiet: true, asset: '^json', verbose: true ,to:"/"});
  console.log('done')
}

main();
