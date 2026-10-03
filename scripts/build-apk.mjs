// Android APK: web build -> Capacitor sync -> Gradle debug build -> release/SITE-9.apk.
// JDK 21 and the Android SDK come from the portable install in ~/.android-build
// (jdk/jdk-21*, sdk), else JAVA_HOME / ANDROID_HOME. Run: npm run android:build
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const portable = path.join(os.homedir(), '.android-build');
const jdkDir = path.join(portable, 'jdk');
// The portable JDK 21 first: Capacitor 8 needs 21, and a system JAVA_HOME is often older.
const portableJdk = fs.existsSync(jdkDir) ? fs.readdirSync(jdkDir).find((d) => d.startsWith('jdk-21')) : undefined;
const javaHome = portableJdk ? path.join(jdkDir, portableJdk) : process.env.JAVA_HOME;
const androidHome = process.env.ANDROID_HOME || path.join(portable, 'sdk');
if (!javaHome || !fs.existsSync(path.join(javaHome, 'bin'))) throw new Error('JDK 21 not found: set JAVA_HOME');
if (!fs.existsSync(androidHome)) throw new Error('Android SDK not found: set ANDROID_HOME');

const env = { ...process.env, JAVA_HOME: javaHome, ANDROID_HOME: androidHome, PATH: `${path.join(javaHome, 'bin')}${path.delimiter}${process.env.PATH}` };
const run = (cmd, cwd = root) => execSync(cmd, { cwd, env, stdio: 'inherit' });

// Gradle reads the SDK location from here (machine-specific, not committed).
fs.writeFileSync(path.join(root, 'android', 'local.properties'), `sdk.dir=${androidHome.replace(/\\/g, '/')}\n`);

run('npm run build');
run('npx cap sync android');

// Phones play the MP3 twins (src/audio: compressedUrl); the WAVs are for desktop and the trailer tools.
let dropped = 0;
const walk = (dir) => {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) walk(p);
    else if (f.name.endsWith('.wav') && fs.existsSync(p.replace(/\.wav$/, '.mp3'))) {
      dropped += fs.statSync(p).size;
      fs.rmSync(p);
    }
  }
};
walk(path.join(root, 'android', 'app', 'src', 'main', 'assets', 'public', 'audio'));
console.log(`APK: left out ${(dropped / 1e6).toFixed(1)} MB of WAVs with MP3 twins`);
const androidDir = path.join(root, 'android');
const apk = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
// Packaged fresh: an incremental repackage keeps the space of removed files (19 MB of gaps).
fs.rmSync(apk, { force: true });
run(`"${path.join(androidDir, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew')}" assembleDebug --console=plain`, androidDir);

fs.mkdirSync(path.join(root, 'release'), { recursive: true });
fs.copyFileSync(apk, path.join(root, 'release', 'SITE-9.apk'));
console.log(`APK: release/SITE-9.apk (${(fs.statSync(apk).size / 1e6).toFixed(1)} MB)`);
