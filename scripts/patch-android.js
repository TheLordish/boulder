/* patch-android.js — everything the generated Android project needs that
   Capacitor does not add for us.

   Runs after `cap add android` in CI, so the android/ folder never has to be
   committed. Each patch is idempotent: the script can run twice without
   duplicating anything. */
const fs = require("fs");
const path = require("path");

const MANIFEST = "android/app/src/main/AndroidManifest.xml";

// Health Connect declares its permissions in the manifest, and Android 14 also
// wants an intent filter so the permission screen knows where to send the user.
const PERMISSIONS = [
  "android.permission.health.READ_STEPS",
  "android.permission.health.READ_ACTIVE_CALORIES_BURNED",
  "android.permission.health.READ_TOTAL_CALORIES_BURNED",
  "android.permission.health.READ_WEIGHT",
  "android.permission.health.READ_BODY_FAT",
  "android.permission.health.READ_LEAN_BODY_MASS",
  "android.permission.health.READ_EXERCISE",
  "android.permission.POST_NOTIFICATIONS",
  "android.permission.SCHEDULE_EXACT_ALARM",
  "android.permission.USE_EXACT_ALARM",
  "android.permission.RECEIVE_BOOT_COMPLETED"
];

const RATIONALE = `
        <intent-filter>
            <action android:name="androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE" />
        </intent-filter>`;

const QUERIES = `
    <queries>
        <package android:name="com.google.android.apps.healthdata" />
        <intent>
            <action android:name="androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE" />
        </intent>
    </queries>`;

function patchManifest() {
  let m = fs.readFileSync(MANIFEST, "utf8");

  PERMISSIONS.forEach(function (p) {
    if (m.indexOf(p) === -1) {
      m = m.replace("</manifest>", `    <uses-permission android:name="${p}" />\n</manifest>`);
    }
  });

  if (m.indexOf("<queries>") === -1) {
    m = m.replace("</manifest>", QUERIES + "\n</manifest>");
  }

  if (m.indexOf("ACTION_SHOW_PERMISSIONS_RATIONALE") === -1 ||
      m.indexOf("<activity") > -1 && m.indexOf(RATIONALE.trim()) === -1) {
    // attach the rationale filter to the main activity
    m = m.replace(/(<activity[^>]*MainActivity[\s\S]*?)(\n\s*<\/activity>)/,
      (_, body, close) => body + RATIONALE + close);
  }

  fs.writeFileSync(MANIFEST, m);
  console.log("manifest patched");
}

// Health Connect needs a recent compile target and Java 17.
function patchGradle() {
  const f = "android/variables.gradle";
  if (!fs.existsSync(f)) return;
  let g = fs.readFileSync(f, "utf8");
  g = g.replace(/minSdkVersion\s*=\s*\d+/, "minSdkVersion = 26");
  fs.writeFileSync(f, g);
  console.log("gradle variables patched");
}

// A white-on-transparent status bar icon, so notifications do not show a square.
function statusIcon() {
  const dir = "android/app/src/main/res/drawable";
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "ic_stat_boulder.xml"),
`<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp" android:height="24dp"
    android:viewportWidth="100" android:viewportHeight="100">
  <path android:fillColor="#FFFFFFFF"
        android:pathData="M10,83 L90,39 A5.5,5.5 0 0,0 90,33 L10,77 A5.5,5.5 0 0,0 10,83 Z"/>
  <path android:fillColor="#FFFFFFFF"
        android:pathData="M62,38 m-14,0 a14,14 0 1,0 28,0 a14,14 0 1,0 -28,0"/>
</vector>`);
  console.log("status bar icon written");
}

patchManifest();
patchGradle();
statusIcon();
