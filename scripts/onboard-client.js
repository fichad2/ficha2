import admin from "firebase-admin";
import fs from "node:fs";
import { randomBytes } from "node:crypto";

const args = process.argv.slice(2);

const printUsage = () => {
  console.log(
    [
      "Uso:",
      "node scripts/onboard-client.js <serviceAccount.json> --company-name \"Empresa\" --admin-email \"admin@empresa.com\" [opciones]",
      "",
      "Opciones:",
      "--company-id <id>          ID fijo de empresa (si no, se genera automaticamente)",
      "--cif <valor>              CIF de la empresa",
      "--address <valor>          Direccion",
      "--responsable <valor>      Responsable",
      "--admin-password <valor>   Contrasena inicial del admin (si no, se genera temporal)",
    ].join("\n")
  );
};

if (args.length < 1 || args.includes("--help") || args.includes("-h")) {
  printUsage();
  process.exit(args.length < 1 ? 1 : 0);
}

const serviceAccountPath = args[0];
const optionTokens = args.slice(1);

const readOption = (name) => {
  const idx = optionTokens.indexOf(name);
  if (idx === -1) return null;
  return optionTokens[idx + 1] ?? null;
};

const companyName = readOption("--company-name");
const adminEmailRaw = readOption("--admin-email");
const companyIdRaw = readOption("--company-id");
const cif = readOption("--cif");
const address = readOption("--address");
const responsable = readOption("--responsable");
const adminPasswordArg = readOption("--admin-password");

if (!companyName || !adminEmailRaw) {
  console.error("Faltan parametros obligatorios: --company-name y --admin-email.");
  printUsage();
  process.exit(1);
}

const normalizeEmail = (value) => value.trim().toLowerCase();
const slugify = (value) =>
  value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 30);

const generateCompanyId = (name) => {
  const slug = slugify(name) || "empresa";
  const suffix = Date.now().toString(36).slice(-6);
  return `${slug}-${suffix}`;
};

const generatePassword = () => {
  const chunk = randomBytes(12).toString("base64url");
  return `Tmp!${chunk}9`;
};

const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, "utf-8"));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const auth = admin.auth();

const companyId = companyIdRaw || generateCompanyId(companyName);
const adminEmail = normalizeEmail(adminEmailRaw);

const companyRef = db.collection("companies").doc(companyId);
const now = admin.firestore.FieldValue.serverTimestamp();

const companyData = {
  name: companyName,
  cif: cif || "",
  address: address || "",
  responsable: responsable || "",
  updatedAt: now,
};

const companySnap = await companyRef.get();
if (!companySnap.exists) {
  companyData.createdAt = now;
}

await companyRef.set(companyData, { merge: true });

let authUser = null;
let adminPassword = adminPasswordArg || null;
let createdAuthUser = false;

try {
  authUser = await auth.getUserByEmail(adminEmail);
} catch (error) {
  if (error.code !== "auth/user-not-found") {
    throw error;
  }
}

if (!authUser) {
  if (!adminPassword) {
    adminPassword = generatePassword();
  }

  authUser = await auth.createUser({
    email: adminEmail,
    password: adminPassword,
    emailVerified: false,
  });
  createdAuthUser = true;
}

await db
  .collection("users")
  .doc(authUser.uid)
  .set(
    {
      email: adminEmail,
      role: "administrador",
      companyId,
      createdAt: now,
      updatedAt: now,
    },
    { merge: true }
  );

const verificationLink = await auth.generateEmailVerificationLink(adminEmail);
const resetPasswordLink = await auth.generatePasswordResetLink(adminEmail);

console.log("Alta completada.");
console.log(`Empresa: ${companyName}`);
console.log(`companyId: ${companyId}`);
console.log(`Admin email: ${adminEmail}`);
console.log(`Admin uid: ${authUser.uid}`);
console.log(`Usuario auth creado ahora: ${createdAuthUser ? "si" : "no"}`);

if (createdAuthUser) {
  console.log(`Contrasena inicial: ${adminPassword}`);
}

console.log("Link verificacion email:");
console.log(verificationLink);
console.log("Link reset password:");
console.log(resetPasswordLink);
