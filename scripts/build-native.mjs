import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "win32") {
  process.stdout.write("Native worker containment is Windows-only; build skipped on this platform.\n");
  process.exit(0);
}

const source = join(root, "native", "windows-worker-launcher.cpp");
const outputDirectory = join(root, "dist", "native");
mkdirSync(outputDirectory, { recursive: true });

function available(command) {
  return spawnSync("where.exe", [command], { stdio: "ignore", windowsHide: true }).status === 0;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
    windowsVerbatimArguments: options.windowsVerbatimArguments ?? false,
  });
  if (result.error || result.status !== 0) process.exit(result.status ?? 1);
}

function findVsDevCmd() {
  const candidates = [
    join(process.env["ProgramFiles(x86)"] ?? "", "Microsoft Visual Studio", "Installer", "vswhere.exe"),
    join(process.env.ProgramFiles ?? "", "Microsoft Visual Studio", "Installer", "vswhere.exe"),
  ];
  for (const vswhere of candidates) {
    if (vswhere.startsWith("Microsoft Visual Studio")) continue;
    const result = spawnSync(vswhere, [
      "-latest",
      "-products", "*",
      "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
      "-property", "installationPath",
    ], { encoding: "utf8", windowsHide: true });
    const installation = result.status === 0 ? result.stdout.trim() : "";
    if (installation !== "") return join(installation, "Common7", "Tools", "VsDevCmd.bat");
  }
  return undefined;
}

function quoteCmd(value) {
  if (/[\r\n"&|<>^]/u.test(value)) {
    throw new Error("Native build path contains a character unsupported by the fixed MSVC command.");
  }
  return `"${value}"`;
}

function buildMsvc(output, testBuild, vsDevCmd) {
  const object = output.replace(/\.exe$/iu, ".obj");
  const args = [
    "/nologo",
    "/std:c++17",
    "/EHsc",
    "/W4",
    "/WX",
    "/DUNICODE",
    "/D_UNICODE",
    ...(testBuild ? ["/DXIAOQIE_CONTAINMENT_TEST_BUILD=1"] : []),
    `/Fo:${object}`,
    source,
    "/link",
    "advapi32.lib",
    `/OUT:${output}`,
  ];
  if (vsDevCmd === undefined) {
    run("cl.exe", args);
    return;
  }
  const command = `call ${quoteCmd(vsDevCmd)} -no_logo -arch=x64 >nul && cl.exe ${args.map(quoteCmd).join(" ")}`;
  // CMD does not use the C-runtime backslash quoting that Node normally adds.
  // Keep this fixed command line verbatim so a quoted Visual Studio path with
  // spaces reaches CALL as ordinary CMD syntax.
  run("cmd.exe", ["/d", "/c", command], { windowsVerbatimArguments: true });
}

function buildMingw(output, testBuild) {
  run("g++.exe", [
    "-std=c++17",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-DUNICODE",
    "-D_UNICODE",
    ...(testBuild ? ["-DXIAOQIE_CONTAINMENT_TEST_BUILD=1"] : []),
    source,
    "-municode",
    "-static-libgcc",
    "-static-libstdc++",
    "-ladvapi32",
    "-o",
    output,
  ]);
}

const vsDevCmd = available("cl.exe") ? undefined : findVsDevCmd();
const compiler = available("cl.exe") || vsDevCmd !== undefined
  ? "msvc"
  : available("g++.exe") ? "mingw" : undefined;
if (compiler === undefined) {
  process.stderr.write("No supported native compiler found (MSVC cl.exe or MinGW-w64 g++.exe).\n");
  process.exit(1);
}

for (const [name, testBuild] of [
  ["xiaoqie-worker-launcher.exe", false],
  ["xiaoqie-worker-test-launcher.exe", true],
]) {
  const output = join(outputDirectory, name);
  if (compiler === "msvc") buildMsvc(output, testBuild, vsDevCmd);
  else buildMingw(output, testBuild);
}

process.stdout.write(`Built fixed Windows containment helpers with ${compiler}.\n`);
