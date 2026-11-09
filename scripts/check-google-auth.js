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
assert.match(server, /app\.use\("\/\_\_\/auth", \(req, res\) => \{/, "Firebase auth helper requests must use the same-origin reverse proxy");
assert.match(server, /projectId \+ "\.firebaseapp\.com"/, "Firebase auth proxy must target the configured Firebase project, not a request-controlled host");
assert.match(server, /RIGHT\(REGEXP_REPLACE\(COALESCE\(phone, ''\), '\[\^0-9\]', '', 'g'\), 10\) = \$1/, "Phone duplicate checks must compare normalized last 10 digits");
assert.match(server, /LOWER\(BTRIM\(email\)\) = \$1/, "Existing email lookup must be case-insensitive and trim surrounding whitespace");
assert.match(server, /code: "EXISTING_EMAIL"/, "Existing email conflicts must return a stable conflict code");
assert.match(html, /code === "EXISTING_EMAIL"/, "Frontend must show existing-account guidance for email conflicts");
assert.match(html, /error\.status = response\.status/, "Frontend must retain backend HTTP status for account conflict handling");
assert.match(html, /id="googleSignInButton"/, "Customer auth UI must include a Google sign-in button");
assert.match(html, /signInWithRedirect\(provider\)/, "Closed Google popup must explain how existing-account customers can sign in");
assert.match(html, /GKK Google sign-in.*Authentication failed/, "Firebase failures must be logged with a diagnostic code");
assert.match(html, /signInWithRedirect\(provider\)/, "Google sign-in must use redirect flow to avoid popup lifecycle issues");
assert.match(html, /getRedirectResult\(\)/, "Google redirect result must be handled after returning to the site");
assert.match(html, /html\.google-auth-return-pending body:before/, "Google redirect return must show a blocking sign-in screen before the homepage paints");
assert.match(html, /You are not signed in yet\. Google did not complete the sign-in\./, "An incomplete redirect must clearly tell customers they are not signed in");
assert.match(html, /unauthorized-domain/, "Unauthorized Firebase domains must show a specific message");
assert.match(html, /account-exists-with-different-credential/, "Existing Google/email credential conflicts must show a useful message");
assert.match(html, /google-signin-highlight/, "Google sign-in button must have a distinct visual treatment");
assert.match(html, /fetch\("\/api\/auth\/google"/, "Browser must submit the Firebase token to the backend");
assert.match(html, /PHONE_REQUIRED/, "New Google accounts must complete the phone onboarding step");
assert.match(html, /currentUser = data\.user/, "Google sign-in must update the existing account state");
assert.match(server, /app\.post\("\/api\/auth\/phone-otp-login"/, "Backend must expose phone OTP login");
assert.match(server, /decoded\.phone_number/, "Phone OTP login must use the verified phone claim");
assert.match(html, /id="gkkShowOtpButton"/, "Customer login must offer mobile OTP");
assert.match(html, /signInWithPhoneNumber\(e164, otpRecaptcha\)/, "Frontend must send OTP through Firebase Phone Auth");
assert.match(html, /phone-otp-login/, "Frontend must exchange the verified phone token for a GKK session");

const inlineGoogleScript = html.match(/<script id="gkk-google-signin">([\s\S]*?)<\/script>/);
assert.ok(inlineGoogleScript, "Google sign-in browser script must exist");
new vm.Script(server, { filename: "server.js" });
new vm.Script(inlineGoogleScript[1], { filename: "gkk-google-signin.inline.js" });

console.log("Google sign-in staging checks passed.");

// Trigger a fresh staging auto-deploy after the diagnostic changes passed CI.
