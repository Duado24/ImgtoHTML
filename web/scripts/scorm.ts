/** npm run scorm: package the built page (dist/) as a SCORM 1.2 .zip that an
 *  LMS such as Canvas can import. Adds imsmanifest.xml and scorm.js (marks
 *  the activity completed when opened). The page itself is unchanged: it
 *  still works offline and sends nothing anywhere.
 *
 *  Output: dist-scorm/ImgtoHTML_SCORM.zip */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

const root = resolve(import.meta.dirname, "..");
const dist = join(root, "dist");
const outDir = join(root, "dist-scorm");
const zipPath = join(outDir, "ImgtoHTML_SCORM.zip");

const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function filesIn(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesIn(path) : [relative(dist, path).split("\\").join("/")];
  });
}

export function manifest(files: readonly string[], title = "ImgtoHTML"): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="ImgtoHTML" version="1.0"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.imsproject.org/xsd/imscp_rootv1p1p2 imscp_rootv1p1p2.xsd http://www.adlnet.org/xsd/adlcp_rootv1p2 adlcp_rootv1p2.xsd">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>1.2</schemaversion>
  </metadata>
  <organizations default="imgtohtml-org">
    <organization identifier="imgtohtml-org">
      <title>${xml(title)}</title>
      <item identifier="imgtohtml-item" identifierref="imgtohtml-page">
        <title>${xml(title)}</title>
      </item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="imgtohtml-page" type="webcontent" adlcp:scormtype="sco" href="index.html">
${files.map((f) => `      <file href="${xml(f)}"/>`).join("\n")}
    </resource>
  </resources>
</manifest>
`;
}

/** A plain .zip (deflate), so packaging needs no extra tools on any system. */
export function zip(entries: readonly { name: string; data: Buffer }[]): Buffer {
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const built = filesIn(dist);
  if (!built.includes("index.html")) throw new Error("dist/index.html is missing: run npm run build first.");
  const entries = built.map((name) => {
    let data = readFileSync(join(dist, name));
    if (name === "index.html") data = Buffer.from(data.toString("utf8").replace("</head>", `<script src="scorm.js"></script>\n</head>`), "utf8");
    return { name, data };
  });
  entries.push({ name: "scorm.js", data: readFileSync(join(root, "scorm", "scorm.js")) });
  entries.unshift({ name: "imsmanifest.xml", data: Buffer.from(manifest(entries.map((e) => e.name)), "utf8") });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(zipPath, zip(entries));
  console.log(`SCORM package: ${relative(root, zipPath)} (${entries.length} files, ${Math.round(statSync(zipPath).size / 1024)} KB)`);
}
