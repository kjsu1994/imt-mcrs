import { cp, mkdir } from "node:fs/promises";
await mkdir("public/cesium", { recursive: true });
for (const folder of ["Assets", "Workers", "ThirdParty", "Widgets"])
  await cp(
    `node_modules/cesium/Build/Cesium/${folder}`,
    `public/cesium/${folder}`,
    { recursive: true, force: true },
  );

for (const name of ["LICENSE.md", "ThirdParty.extra.json"]) {
  await cp(`node_modules/cesium/${name}`, `public/cesium/${name}`, {
    force: true,
  }).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
}
