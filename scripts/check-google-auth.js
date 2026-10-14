const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const server = fs.readFileSync("server.js", "utf8");
const html = fs.readFileSync("public/index.html", "utf8");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));

assert.ok(pkg.dependencies["firebase-admin"], "firebase-admin must be installed");
assert.match(server, /const firebaseAdminSdk = require\(["']firebase-admin["']\)/, "Firebase Admin SDK must use a non-conflicting name");
assert.match(server, /firebaseAdminSdk\.auth\(\)\.verifyIdToken\(idToken, true\)/, "Backend must verify and check revocation of Firebase ID tokens");
assert.match(server, /decoded\.email_verified !== true/, "Backend must require a verified Google email");
assert.match(server, /ALTER TABLE users ADD COLUMN IF NOT EXISTS firebase_uid TEXT UNIQUE/, "Database migration must persist Firebase UIDs");
assert.match(server, /FIREBASE_SERVICE_ACCOUNT_JSON/, "Admin credentials must come from a server-side environment variable");
assert.match(server, /FIREBASE_API_KEY/, "Firebase web config must be supplied from environment variables");
assert.match(server, /RIGHT\(REGEXP_REPLACE\(COALESCE\(phone, ''\), '\[\^0-9\]', '', 'g'\), 10\) = \$1/, "Phone duplicate checks must compare normalized last 10 digits");
assert.match(html, /id="googleSignInButton"/, "Customer auth UI must include a Google sign-in button");
assert.match(html, /Google's sign-in window closed before Ghar ka Khana received the result/, "Closed Google popup must explain how existing-account customers can sign in");
assert.match(html, /GKK Google sign-in.*Firebase authentication failed/, "Firebase failures must be logged with a diagnostic code");
assert.match(html, /unauthorized-domain/, "Unauthorized Firebase domains must show a specific message");
assert.match(html, /popup-blocked/, "Blocked popups must show a specific message");
assert.match(html, /google-signin-highlight/, "Google sign-in button must have a distinct visual treatment");
assert.match(html, /fetch\("\/api\/auth\/google"/, "Browser must submit the Firebase token to the backend");
assert.match(html, /PHONE_REQUIRED/, "New Google accounts must complete the phone onboarding step");
assert.match(html, /currentUser = data\.user/, "Google sign-in must update the existing account state");

const inlineGoogleScript = html.match(/<script id="gkk-google-signin">([\s\S]*?)<\/script>/);
assert.ok(inlineGoogleScript, "Google sign-in browser script must exist");
new vm.Script(server, { filename: "server.js" });
new vm.Script(inlineGoogleScript[1], { filename: "gkk-google-signin.inline.js" });

console.log("Google sign-in staging checks passed.");

// Trigger a fresh staging auto-deploy after the diagnostic changes passed CI.
