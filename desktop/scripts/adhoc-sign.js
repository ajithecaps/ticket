// Apple silicon refuses to open an app whose signature is broken ("Tickets is damaged"), and
// electron-builder leaves Electron's signature broken when no Developer ID certificate is set up.
// So, unless real signing is configured (CSC_LINK / CSC_NAME), sign the app ad-hoc. People then get
// the normal "unidentified developer" prompt, which right-click › Open gets past.
const { execFileSync } = require("child_process");
const path = require("path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  if (process.env.CSC_LINK || process.env.CSC_NAME) return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
  console.log(`  • ad-hoc signed ${appPath}`);
};
