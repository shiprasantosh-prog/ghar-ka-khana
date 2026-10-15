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
assert.match(html, /unauthorized-domain/, "Unauthorized Firebase domains must show a specific message");
assert.match(html, /account-exists-with-different-credential/, "Existing Google/email credential conflicts must show a useful message");
assert.match(html, /google-signin-highlight/, "Google sign-in button must have a distinct visual treatment");
assert.match(html, /fetch\("\/api\/auth\/google"/, "Browser must submit the Firebase token to the backend");
assert.match(html, /PHONE_REQUIRED/, "New Google accounts must complete the phone onboarding step");
assert.match(html, /currentUser = data\.user/, "Google sign-in must update the existing account state");
assert.match(server, /SET email = COALESCE\(NULLIF\(BTRIM\(email\), ''\), \$2\), firebase_uid = \$1/, "Linking an existing phone account must save the verified Google email and Firebase UID on the same user row");
assert.match(server, /UPDATE users SET email = COALESCE\(NULLIF\(BTRIM\(email\), ''\), \$2\) WHERE firebase_uid = \$1 AND \(email IS NULL OR BTRIM\(email\) = '' OR LOWER\(BTRIM\(email\)\) = \$2\)/, "Repeat sign-ins for an existing Firebase UID must save a missing verified email without overwriting a different email");
assert.match(server, /code: "EMAIL_ALREADY_IN_USE"/, "Existing UID email conflicts must be handled without creating or overwriting user accounts");
assert.match(server, /LOWER\(BTRIM\(email\)\) = \$2/, "Account linking must avoid overwriting an email already associated with a different account");
assert.match(html, /Finishing Google sign-in…/, "Redirect return must show immediate progress feedback");
assert.match(server, /code: "EXISTING_PHONE"/, "Existing phone numbers must require verification instead of creating duplicate accounts");
assert.match(server, /bcrypt\\.compareSync\\(password, existing\\.password_hash\\)/, "Existing customer linking must verify the existing password");
assert.match(html, /data.code === "EXISTING_PHONE"/, "Frontend must show verification when the submitted phone already exists");
assert.match(html, /gkkGoogleRedirectPending/, "Google redirect return should keep the account section visible");

const inlineGoogleScript = html.match(/<script id="gkk-google-signin">([\s\S]*?)<\/script>/);
assert.ok(inlineGoogleScript, "Google sign-in browser script must exist");
new vm.Script(server, { filename: "server.js" });
new vm.Script(inlineGoogleScript[1], { filename: "gkk-google-signin.inline.js" });

console.log("Google sign-in staging checks passed.");

// Trigger a fresh staging auto-deploy after the diagnostic changes passed CI.
